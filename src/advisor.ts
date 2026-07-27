import type { BridgeDb } from "./db.js";
import type { BotConfig, BotKind } from "./types.js";
import { buildCliInvocation, parseCliResult } from "./cli.js";
import { setAntigravityModel } from "./providers/antigravityRuntime.js";
import { classifyProviderError, isFallbackEligibleProviderError } from "./providers/errorClassification.js";
import type { ProviderId } from "./providers/types.js";
import { assertChainSupportsProfile, shouldAllowAdvisorCall, type AdvisorExecutionProfile } from "./advisorPolicy.js";
import {
  buildAdvisorContext,
  buildAdvisorDebugFinalPrompt,
  buildAdvisorPrompt,
  buildAdvisorToolSelectionPrompt,
  parseAdvisorDebugOutput,
  parseAdvisorOutput,
  parseAdvisorToolSelection,
} from "./advisorPrompt.js";
import { parseAdvisorEvidenceToolRequest, type AdvisorEvidenceToolBroker } from "./advisorEvidenceTools.js";
import type { AdvisorConfig, AdvisorRequest, AdvisorResult } from "./advisorTypes.js";

type RunCli = (command: string, args: string[], cwd: string, options: Record<string, unknown>) => Promise<string>;
const botKindFor = (provider: ProviderId): BotKind => provider === "agy" ? "antigravity" : provider;
function errorKind(error: Error, provider: ProviderId): string {
  if (/invalid advisor output|invalid advisor tool selection|invalid advisor debug output/i.test(error.message)) return "invalid_output";
  if (/timeout/i.test(error.message)) return "timeout";
  return classifyProviderError(provider, error).kind;
}
function fallbackEligible(error: Error, provider: ProviderId): boolean {
  const classification = classifyProviderError(provider, error);
  return /invalid advisor output|invalid advisor tool selection|invalid advisor debug output|timeout|provider unavailable/i.test(error.message)
    || classification.kind === "auth_required"
    || classification.kind === "transient"
    || isFallbackEligibleProviderError(classification);
}
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Advisor timeout")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
function parseRawResult<T>(provider: ProviderId, raw: string, parser: (value: string) => T): T {
  try { return parser(raw); }
  catch {
    return parser(parseCliResult({ bot: botKindFor(provider), stdout: raw }).text);
  }
}

interface AdvisorExecutionDeps {
  db: BridgeDb;
  config: AdvisorConfig;
  request: AdvisorRequest;
  bots: Partial<Record<BotKind, Pick<BotConfig, "command" | "modelPreference">>>;
  runCli: RunCli;
  cwd: string;
  executionProfile: AdvisorExecutionProfile;
}

class AdvisorPromptExecutionError extends Error {
  constructor(readonly provider: ProviderId, error: Error) {
    super(error.message);
    this.name = "AdvisorPromptExecutionError";
    this.stack = error.stack;
  }
}

function validateAdvisorRequest(deps: AdvisorExecutionDeps): void {
  const { config, request } = deps;
  if (!config.enabled) throw new Error("Advisor disabled");
  if (config.chain.length === 0) throw new Error("Advisor unavailable: no configured targets");
  assertChainSupportsProfile(config.chain, deps.executionProfile);
  if (!shouldAllowAdvisorCall(config.mode, request.origin, request.approved === true)) throw new Error("Advisor call denied by policy");
}

async function executeAdvisorPrompt<T>(
  deps: AdvisorExecutionDeps,
  prompt: string,
  parser: (value: string) => T,
  startOrdinal: number,
): Promise<{ value: T; provider: ProviderId; model: string; nextOrdinal: number }> {
  const { db, config, bots, runCli, cwd, request } = deps;
  let lastError: Error | null = null;
  let lastProvider = config.chain[0].provider;
  let ordinal = startOrdinal;

  for (let index = 0; index < config.chain.length; index++, ordinal++) {
    const target = config.chain[index];
    lastProvider = target.provider;
    const bot = botKindFor(target.provider);
    const botConfig = bots[bot];
    const startedAt = Date.now();
    try {
      if (!botConfig?.command) throw new Error(`Advisor provider unavailable: ${target.provider}`);
      if (target.provider === "agy") setAntigravityModel(target.model);
      const invocation = buildCliInvocation({
        bot,
        prompt,
        sessionId: null,
        command: botConfig.command,
        model: target.model,
        executionMode: "safe",
        outputFormat: "json",
        toolMode: "none",
      });
      const raw = await withTimeout(
        runCli(invocation.command, invocation.args, cwd, { timeoutMs: config.timeoutMs, advisorChild: true, bot }),
        config.timeoutMs,
      );
      const value = parseRawResult(target.provider, raw, parser);
      db.addAdvisorAttempt({
        requestId: request.requestId,
        ordinal,
        provider: target.provider,
        model: target.model,
        status: "succeeded",
        durationMs: Date.now() - startedAt,
      });
      return { value, provider: target.provider, model: target.model, nextOrdinal: ordinal + 1 };
    } catch (caught) {
      const error = caught instanceof Error ? caught : new Error(String(caught));
      lastError = error;
      db.addAdvisorAttempt({
        requestId: request.requestId,
        ordinal,
        provider: target.provider,
        model: target.model,
        status: "failed",
        errorKind: errorKind(error, target.provider),
        durationMs: Date.now() - startedAt,
      });
      if (index + 1 >= config.chain.length || !fallbackEligible(error, target.provider)) break;
    }
  }

  throw new AdvisorPromptExecutionError(lastProvider, lastError ?? new Error("Advisor failed"));
}

function reserveAdvisorRequest(deps: AdvisorExecutionDeps, contextChars: number): void {
  const { db, config, request } = deps;
  if (!db.reserveAdvisorCall({
    requestId: request.requestId,
    scopeKey: request.scopeKey,
    turnKey: request.turnKey,
    taskKey: request.taskKey,
    mode: request.mode,
    trigger: request.origin,
    contextChars,
    maxCallsPerTurn: config.maxCallsPerTurn,
    maxCallsPerTask: config.maxCallsPerTask,
  })) throw new Error("Advisor budget exhausted");
}

function failAdvisorRequest(deps: AdvisorExecutionDeps, caught: unknown): never {
  const error = caught instanceof Error ? caught : new Error(String(caught));
  const provider = error instanceof AdvisorPromptExecutionError ? error.provider : deps.config.chain[0].provider;
  deps.db.failAdvisorCall(deps.request.requestId, errorKind(error, provider));
  throw error;
}

/**
 * Single private execution path for ordinary advisor requests. All callers share
 * the same policy, logical-call budget, tool-disabled provider invocation,
 * fallback, and audit behaviour.
 */
export async function executeAdvisorRequest(deps: AdvisorExecutionDeps): Promise<AdvisorResult> {
  validateAdvisorRequest(deps);
  const { db, config, request } = deps;
  const context = buildAdvisorContext(db, {
    scopeKey: request.scopeKey,
    task: request.task,
    maxChars: config.contextMaxChars,
    evidence: request.evidence,
  });
  reserveAdvisorRequest(deps, context.length);
  try {
    const prompt = buildAdvisorPrompt({
      mode: request.mode,
      activeProvider: request.activeProvider,
      activeModel: request.activeModel,
      context,
    });
    const completed = await executeAdvisorPrompt(deps, prompt, parseAdvisorOutput, 1);
    db.completeAdvisorCall(request.requestId, completed.provider, completed.model, completed.value.confidence);
    return { ...completed.value, provider: completed.provider, model: completed.model, requestId: request.requestId };
  } catch (error) {
    return failAdvisorRequest(deps, error);
  }
}

/**
 * Tool-assisted debugging still invokes every provider with toolMode:none. The
 * model selects typed read-only evidence requests; Agent Bridge validates and
 * executes them through the supplied broker. Both model turns consume one
 * logical advisor budget row and share one request/attempt audit sequence.
 */
export async function executeAdvisorInvestigation(
  deps: AdvisorExecutionDeps & { evidenceTools: AdvisorEvidenceToolBroker },
): Promise<AdvisorResult> {
  validateAdvisorRequest(deps);
  if (deps.request.mode !== "debug") throw new Error("Advisor evidence investigation is available only in debug mode");
  const { db, config, request } = deps;
  const context = buildAdvisorContext(db, {
    scopeKey: request.scopeKey,
    task: request.task,
    maxChars: config.contextMaxChars,
    evidence: request.evidence,
  });
  reserveAdvisorRequest(deps, context.length);

  try {
    const selectionPrompt = buildAdvisorToolSelectionPrompt({
      activeProvider: request.activeProvider,
      activeModel: request.activeModel,
      context,
      maxToolCalls: 6,
    });
    const selection = await executeAdvisorPrompt(
      deps,
      selectionPrompt,
      (raw) => {
        const parsed = parseAdvisorToolSelection(raw, 6);
        try {
          return { ...parsed, toolRequests: parsed.toolRequests.map(parseAdvisorEvidenceToolRequest) };
        } catch (error) {
          throw new Error(`Invalid advisor tool selection: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
      1,
    );
    const toolResults = await deps.evidenceTools.execute(selection.value.toolRequests);
    const finalPrompt = buildAdvisorDebugFinalPrompt({
      activeProvider: request.activeProvider,
      activeModel: request.activeModel,
      context,
      hypothesis: selection.value.hypothesis,
      missingEvidence: selection.value.missingEvidence,
      results: toolResults,
    });
    const knownEvidenceIds = new Set(toolResults.map((result) => result.evidenceId));
    const completed = await executeAdvisorPrompt(
      deps,
      finalPrompt,
      (raw) => {
        const parsed = parseAdvisorDebugOutput(raw);
        const declaredEvidenceIds = new Set(parsed.evidenceIds);
        const basisEvidenceIds = new Set<string>();
        if (toolResults.length > 0 && parsed.evidenceBasis.length === 0) {
          throw new Error("Invalid advisor debug output: evidence_basis is required after tool use");
        }
        for (const basis of parsed.evidenceBasis) {
          for (const id of basis.evidenceIds) {
            if (!knownEvidenceIds.has(id)) {
              throw new Error("Invalid advisor debug output: evidence_basis referenced unknown evidence identifier");
            }
            if (!declaredEvidenceIds.has(id)) {
              throw new Error("Invalid advisor debug output: evidence_basis identifier missing from evidence_ids");
            }
            basisEvidenceIds.add(id);
          }
        }
        if (parsed.evidenceIds.some((id) => !knownEvidenceIds.has(id))) {
          throw new Error("Invalid advisor debug output: referenced unknown evidence identifier");
        }
        if (parsed.evidenceIds.some((id) => !basisEvidenceIds.has(id))) {
          throw new Error("Invalid advisor debug output: every evidence identifier must support a structured claim");
        }
        return parsed;
      },
      selection.nextOrdinal,
    );
    const hasLimitedEvidence = selection.value.missingEvidence.length > 0
      || completed.value.unresolvedConflicts.length > 0
      || toolResults.some((result) => result.status !== "ok" || result.truncated);
    const confidence = hasLimitedEvidence && completed.value.confidence === "high"
      ? "medium"
      : completed.value.confidence;
    db.completeAdvisorCall(request.requestId, completed.provider, completed.model, confidence);
    return {
      ...completed.value,
      confidence,
      provider: completed.provider,
      model: completed.model,
      requestId: request.requestId,
    };
  } catch (error) {
    return failAdvisorRequest(deps, error);
  }
}

export function formatAdvisorResult(result: AdvisorResult): string {
  return [
    "**Advisor view**", "", result.adviceMd,
    ...(result.risks.length ? ["", "**Risks**", ...result.risks.map((risk) => `- ${risk}`)] : []),
    ...(result.suggestedNextSteps.length ? ["", "**Next steps**", ...result.suggestedNextSteps.map((step) => `- ${step}`)] : []),
    ...(result.verificationSteps?.length ? ["", "**Verification**", ...result.verificationSteps.map((step) => `- ${step}`)] : []),
    "", `Advisor: ${result.provider}:${result.model} · confidence ${result.confidence}`,
  ].join("\n");
}
