import { randomUUID } from "node:crypto";
import type { BridgeDb } from "./db.js";
import type { BotConfig, BotKind } from "./types.js";
import { buildCliInvocation, parseCliResult, runProviderInvocation } from "./cli.js";
import { supportsToolFreeMode } from "./providers/registry.js";
import type { ProviderId } from "./providers/types.js";
import type { AdvisorConfig, AdvisorTarget } from "./advisorTypes.js";
import type { RouteableBotKind } from "./types.js";
import { discoverAcpProviderConfig } from "./providers/acpConfigDiscovery.js";
import { advisorModelClass, selectAdvisorClassModel } from "./advisorModelSelection.js";

type RunCli = (command: string, args: string[], cwd: string, options: Record<string, unknown>) => Promise<string>;
const botKindFor = (provider: ProviderId): BotKind | null => {
  if (provider === "agy") return "antigravity";
  if (provider === "custom-acp") return null;
  return provider;
};
const normalizeProvider = (provider: string): string => provider === "antigravity" ? "agy" : provider;

const ADVISOR_SECRET_KEYS = [
  "access[_-]?key", "api[_-]?key", "auth[_-]?token", "bearer[_-]?token",
  "client[_-]?secret", "connection[_-]?string", "credential", "database[_-]?url",
  "db[_-]?url", "github[_-]?token", "gh[_-]?token", "oauth[_-]?token", "password",
  "private[_-]?key", "refresh[_-]?token", "secret", "secret[_-]?access[_-]?key",
  "secret[_-]?key", "session[_-]?token", "token",
].join("|");
const ADVISOR_SECRET_ASSIGNMENT_RE = new RegExp(
  `(["']?(?:${ADVISOR_SECRET_KEYS})["']?\\s*[:=]\\s*)(?:"[^"\\r\\n]*"|'[^'\\r\\n]*'|[^\\s,;]+)`,
  "gi",
);

/** Mechanical cross-provider boundary: scrub common credential shapes before payload leaves Bridge ownership. */
function redactAdvisorSecretText(text: string): string {
  return text
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, "[REDACTED PRIVATE KEY]")
    .replace(ADVISOR_SECRET_ASSIGNMENT_RE, "$1[REDACTED]")
    .replace(/\b((?:proxy-)?authorization\s*:\s*)(?:bearer|basic)\s+[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^\/\s:@]+):([^@\s\/]+)@/gi, "$1[REDACTED]@")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED JWT]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED AWS ACCESS KEY]")
    .replace(/\b(?:gh[opsu]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[REDACTED GITHUB TOKEN]")
    .replace(/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,}|sk_(?:live|test)_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/g, "[REDACTED TOKEN]");
}

function chooseTarget(config: AdvisorConfig, activeProvider: string, requestedProvider?: string): AdvisorTarget {
  const active = normalizeProvider(activeProvider);
  if (requestedProvider) {
    const requested = normalizeProvider(requestedProvider);
    const target = config.chain.find((candidate) => candidate.provider === requested);
    if (!target) throw new Error(`Requested provider is not an allowed advisor provider: ${requestedProvider}`);
    if (target.provider === active) throw new Error("Advisor requires an independent provider");
    const bot = botKindFor(target.provider);
    if (!bot || !supportsToolFreeMode(bot)) {
      throw new Error(`Advisor provider does not support tool-free mode: ${target.provider}`);
    }
    return target;
  }
  const target = config.chain.find((candidate) => {
    const bot = botKindFor(candidate.provider);
    return candidate.provider !== active && bot !== null && supportsToolFreeMode(bot);
  });
  if (!target) throw new Error("Advisor requires an independent provider");
  return target;
}

/** Resolve a class from fresh provider-advertised ACP values, or use that provider's default. */
async function resolveAdvisorModel(target: AdvisorTarget, bot: BotKind, cwd: string): Promise<string | null> {
  if (target.model === "default") return null;
  const modelClass = advisorModelClass(target.provider, target.model);
  if (!modelClass) return target.model; // Legacy exact-model targets retain required matching.
  try {
    const discovered = await discoverAcpProviderConfig({
      bot: bot as RouteableBotKind,
      cwd,
      conversationId: `advisor-model-discovery:${randomUUID()}`,
      existingAcpSessionId: null,
      executionMode: "safe",
    });
    return selectAdvisorClassModel(discovered.configOptions, modelClass);
  } catch {
    // Model catalogue discovery is optional; a separate provider is still required.
    return null;
  }
}

function boundedText(value: unknown, label: string, maxChars: number, required: boolean): string {
  if (typeof value !== "string") {
    if (required) throw new Error(`Advisor ${label} is required`);
    return "";
  }
  const text = value.trim();
  if (required && !text) throw new Error(`Advisor ${label} is required`);
  if (text.length > maxChars) throw new Error(`Advisor ${label} exceeds configured bound (${maxChars} chars)`);
  return text;
}

export interface FrontierAdviceRequest {
  scopeKey: string;
  turnKey?: string;
  taskKey?: string;
  activeProvider: string;
  provider?: string;
  question: string;
  context?: string;
  cwd: string;
  executionId?: string;
}

/**
 * The whole Bridge-owned Advisor primitive: one bounded, tool-free call to one
 * configured provider that is independent of the active provider.
 */
export async function executeFrontierAdvice(deps: {
  db: BridgeDb;
  config: AdvisorConfig;
  bots: Partial<Record<BotKind, Pick<BotConfig, "command" | "modelPreference">>>;
  runCli: RunCli;
  request: FrontierAdviceRequest;
}): Promise<{ text: string; provider: ProviderId; model: string; requestId: string }> {
  const { db, config, bots, runCli, request } = deps;
  if (!config.enabled) throw new Error("Advisor disabled");
  if (config.chain.length === 0) throw new Error("Advisor unavailable: no configured targets");
  const question = redactAdvisorSecretText(boundedText(request.question, "question", Math.min(config.contextMaxChars, 4_000), true));
  const context = redactAdvisorSecretText(boundedText(request.context ?? "", "context", config.contextMaxChars, false));
  const target = chooseTarget(config, request.activeProvider, request.provider);
  const bot = botKindFor(target.provider);
  if (!bot || !supportsToolFreeMode(bot)) throw new Error(`Advisor provider does not support tool-free mode: ${target.provider}`);
  const botConfig = bots[bot];
  if (!botConfig?.command) throw new Error(`Advisor provider unavailable: ${target.provider}`);

  const requestId = randomUUID();
  if (!db.reserveAdvisorCall({
    requestId,
    scopeKey: request.scopeKey,
    turnKey: request.turnKey,
    taskKey: request.taskKey,
    mode: "review",
    trigger: "manual",
    contextChars: question.length + context.length,
    maxCallsPerTurn: config.maxCallsPerTurn,
    maxCallsPerTask: config.maxCallsPerTask,
  })) throw new Error("Advisor budget exhausted");

  const startedAt = Date.now();
  const executionId = request.executionId ?? `advisor:${randomUUID()}`;
  let auditedModel = target.model;
  try {
    const resolvedModel = await resolveAdvisorModel(target, bot, request.cwd);
    auditedModel = resolvedModel ?? "provider-default";
    const prompt = [
      "Give one independent frontier opinion on the question below.",
      `The active provider is ${normalizeProvider(request.activeProvider)}; do not act as its continuation or claim execution ownership.`,
      "Return concise decision-bearing advice. Do not use tools or mutate state.",
      "",
      `Question: ${question}`,
      ...(context ? ["", "Bounded context:", context] : []),
    ].join("\n");
    const invocation = buildCliInvocation({
      bot,
      prompt,
      sessionId: null,
      command: botConfig.command,
      model: resolvedModel,
      executionMode: "safe",
      outputFormat: "json",
      toolMode: "none",
    });
    const requestPayload = {
      prompt,
      sessionId: null,
      command: invocation.command,
      model: resolvedModel,
      modelRequired: resolvedModel !== null,
      modelUseProviderDefault: resolvedModel === null,
      executionMode: "safe" as const,
      outputFormat: "json" as const,
      soulContext: null,
      attachments: [] as string[],
      outputDir: null,
      effort: null,
      toolMode: "none" as const,
    };
    const text = invocation.transport === "acp-stdio"
      ? (await runProviderInvocation(bot, invocation, request.cwd, {
          timeoutMs: config.timeoutMs,
          advisorChild: true,
          bot,
          chatId: executionId,
        }, requestPayload, { conversationId: `advisor:${requestId}`, runId: executionId })).text.trim()
      : parseCliResult({
          bot,
          stdout: await runCli(invocation.command, invocation.args, request.cwd, {
            timeoutMs: config.timeoutMs,
            advisorChild: true,
            bot,
            chatId: executionId,
          }),
        }).text.trim();
    if (!text) throw new Error("Advisor returned empty output");
    if (text.length > config.outputMaxChars) {
      throw new Error(`Advisor output exceeds configured bound (${config.outputMaxChars} chars)`);
    }
    db.addAdvisorAttempt({
      requestId,
      ordinal: 1,
      provider: target.provider,
      model: auditedModel,
      status: "succeeded",
      durationMs: Date.now() - startedAt,
    });
    db.completeAdvisorCall(requestId, target.provider, auditedModel, "medium");
    return { text, provider: target.provider, model: auditedModel, requestId };
  } catch (caught) {
    const error = caught instanceof Error ? caught : new Error(String(caught));
    db.addAdvisorAttempt({
      requestId,
      ordinal: 1,
      provider: target.provider,
      model: auditedModel,
      status: "failed",
      errorKind: /timeout/i.test(error.message) ? "timeout" : "provider_error",
      durationMs: Date.now() - startedAt,
    });
    db.failAdvisorCall(requestId, /timeout/i.test(error.message) ? "timeout" : "provider_error");
    throw error;
  }
}
