/**
 * PURPOSE: Parallel ACP-backed Codex runtime. Speaks ACP rather than parsing
 * Codex exec JSONL. The legacy `codexRuntime.ts` path remains selectable.
 */
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import type { ContentBlock, Usage } from "@agentclientprotocol/sdk";
import { nodeStdioStream, runAcpTurn } from "../acp/index.js";
import type { AcpRetainedEvent, AcpTurnResult } from "../acp/client.js";
import type { AcpObservedUpdate } from "../acp/replay.js";
import { runSupervisedStdioSession } from "../cliSupervisor.js";
import type { CliOptions, CliResult, RunTelemetry } from "../types.js";
import { isAbortRequested } from "../cliSupervisor.js";
import { appendOutputDirInstruction, wrapPromptContext } from "../promptWrapping.js";
import type { ProviderInvocation, ProviderInvocationRequest } from "./types.js";
import { resolveCodexAcpArgs, resolveCodexAcpCommand } from "./codexRuntimeSelection.js";
import {
  getProviderApiKeySecretValues,
  redactProviderApiKeySecrets,
} from "./apiKeyAuth.js";
import { createStreamingSecretRedactor } from "./streamingSecretRedactor.js";
import { type as bridgeEventType } from "../events/types.js";

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/**
 * Codex ACP's "read-only" agent mode restricts mutation/network authority but
 * still permits read/search/think-style tools. It is not equivalent to legacy
 * Codex's `toolMode: "none"`, which disables shell/browser/computer-use/
 * plugins/hooks/goals/apps entirely. The pinned adapter has no config knob
 * that guarantees genuinely tool-free execution, so fail closed rather than
 * silently redefining Advisor's tool-free contract as read-only.
 */
export class CodexAcpToolFreeUnsupportedError extends Error {
  constructor() {
    super(
      "Codex ACP cannot guarantee tool-free execution for toolMode \"none\": " +
      "the pinned adapter's read-only mode still permits read/search tools. Failing closed.",
    );
    this.name = "CodexAcpToolFreeUnsupportedError";
  }
}

export function buildInvocation(request: ProviderInvocationRequest): ProviderInvocation {
  if (request.toolMode === "none") throw new CodexAcpToolFreeUnsupportedError();
  return {
    command: resolveCodexAcpCommand(),
    args: resolveCodexAcpArgs(),
    nativeSessionMode: request.sessionId ? "resume" : "fresh",
    transport: "acp-stdio",
  };
}

export function initialAgentMode(request: Pick<ProviderInvocationRequest, "executionMode" | "toolMode">): string {
  if (request.toolMode === "none") throw new CodexAcpToolFreeUnsupportedError();
  if (request.executionMode === "trusted") return "agent-full-access";
  return "read-only";
}

export function codexAcpConfig(request: Pick<ProviderInvocationRequest, "model" | "effort">): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  if (request.model) config.model = request.model;
  if (request.effort) config.model_reasoning_effort = request.effort;
  return config;
}

/** Codex ACP reads CODEX_API_KEY only during authenticate({ methodId: "api-key" }). */
export function codexAcpChildAuthEnv(
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  if (env.CODEX_API_KEY?.trim() && !env.DEFAULT_AUTH_REQUEST?.trim()) {
    return { DEFAULT_AUTH_REQUEST: JSON.stringify({ methodId: "api-key" }) };
  }
  return {};
}

function promptBlocks(request: ProviderInvocationRequest): ContentBlock[] {
  const wrapped = appendOutputDirInstruction(
    wrapPromptContext(request.prompt, request.soulContext, request.includeResponseContract),
    request.outputDir,
  );
  const blocks: ContentBlock[] = [{ type: "text", text: wrapped }];
  for (const path of request.attachments) {
    const mimeType = IMAGE_MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
    const data = readFileSync(path).toString("base64");
    blocks.push({ type: "image", data, mimeType, uri: `file://${path}` });
  }
  return blocks;
}

/**
 * ACP tool_call/tool_call_update events can carry `rawInput`/`rawOutput`
 * (unknown-shaped provider tool payloads) that may embed provider
 * credentials, e.g. a shell command line or file content containing an API
 * key. Provider secrets must be redacted from lifecycle/event output before
 * it leaves the process boundary, the same contract already applied to
 * delivered text — so scrub every string leaf of the retained event, not
 * just the fields we know about today, before it is persisted.
 */
function redactAcpEventCredentials(event: AcpRetainedEvent, env: NodeJS.ProcessEnv): unknown {
  const secrets = getProviderApiKeySecretValues(env);
  if (secrets.length === 0) return event;
  const redacted = redactProviderApiKeySecrets(JSON.stringify(event), env);
  try {
    return JSON.parse(redacted);
  } catch {
    // A secret value containing JSON-structural characters (quotes, braces)
    // could corrupt the redacted JSON. Fail closed to a placeholder rather
    // than persisting a payload that might still carry the raw secret.
    return { kind: event.kind, channel: event.channel, redacted: "unparseable after credential redaction" };
  }
}

/**
 * A live ACP turn failure (RequestError.data) can embed CODEX_API_KEY in
 * provider-supplied text (message/additionalDetails) — the same structured
 * shape qualification redacts. Turn failures propagate to engine.ts, which
 * logs the raw error, so the credential must be scrubbed in place here
 * before the error leaves this module. Mutates rather than replaces the
 * error so downstream `instanceof`/`.code` classification stays intact.
 */
function redactAcpTurnError(error: unknown, env: NodeJS.ProcessEnv): unknown {
  if (!(error instanceof Error)) return error;
  const secrets = getProviderApiKeySecretValues(env);
  if (secrets.length === 0) return error;
  error.message = redactProviderApiKeySecrets(error.message, env);
  const data = (error as Error & { data?: unknown }).data;
  if (data && typeof data === "object") {
    const redacted = redactProviderApiKeySecrets(JSON.stringify(data), env);
    try {
      (error as Error & { data?: unknown }).data = JSON.parse(redacted);
    } catch {
      (error as Error & { data?: unknown }).data = { redacted: "unparseable after credential redaction" };
    }
  }
  return error;
}

function telemetryFromUsage(usage: Usage | undefined): RunTelemetry | undefined {
  if (!usage) return undefined;
  return {
    provider: "codex",
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.thoughtTokens != null ? { reasoningTokens: usage.thoughtTokens } : {}),
    ...(usage.cachedReadTokens != null ? { cachedInputTokens: usage.cachedReadTokens } : {}),
  };
}

/**
 * Codex ACP tags agent_message_chunk notifications with `_meta.codex.phase`
 * ("commentary" | "final_answer"). This interpretation is Codex-specific and
 * deliberately lives here rather than in the generic ACP core (acp/client.ts,
 * which keeps forwarding every live chunk unchanged for progress display).
 * Agents that supply no phase metadata are treated as before: every live
 * chunk is part of the answer.
 */
type CodexPhase = "commentary" | "final_answer";
type CodexPhaseState = CodexPhase | "absent" | "invalid";

function codexPhaseOf(notification: AcpObservedUpdate["notification"]): CodexPhaseState {
  const meta = notification.update._meta as Record<string, unknown> | null | undefined;
  if (!meta || !Object.prototype.hasOwnProperty.call(meta, "codex")) {
    const outerMeta = notification._meta as Record<string, unknown> | null | undefined;
    return outerMeta && Object.prototype.hasOwnProperty.call(outerMeta, "codex") ? "invalid" : "absent";
  }
  const codex = meta.codex;
  if (!codex || typeof codex !== "object") return "invalid";
  const phase = (codex as { phase?: unknown }).phase;
  return phase === "commentary" || phase === "final_answer" ? phase : "invalid";
}

/** The authoritative final answer, excluding Codex commentary-phase chunks. Replay is always excluded. */
function codexFinalAnswer(updates: readonly AcpObservedUpdate[]): { phaseAware: boolean; text: string } {
  const phaseAware = updates.some((update) => {
    const payload = update.notification.update;
    return payload.sessionUpdate === "agent_message_chunk"
      && payload.content.type === "text"
      && codexPhaseOf(update.notification) !== "absent";
  });
  let text = "";
  for (const update of updates) {
    if (update.channel !== "live") continue;
    const payload = update.notification.update;
    if (payload.sessionUpdate !== "agent_message_chunk") continue;
    if (payload.content.type !== "text") continue;
    if (phaseAware && codexPhaseOf(update.notification) !== "final_answer") continue;
    text += payload.content.text;
  }
  return { phaseAware, text };
}

export function toCliResult(result: AcpTurnResult): CliResult {
  const answer = codexFinalAnswer(result.updates);
  const text = (answer.phaseAware ? answer.text : result.liveText).trim();
  if (!text && result.stopReason !== "cancelled") {
    throw new Error(`Codex ACP completed without authoritative final text (stopReason=${result.stopReason})`);
  }
  return {
    text,
    sessionId: result.acpSessionId,
    stopReason: result.stopReason,
    ...(telemetryFromUsage(result.usage) ? { telemetry: telemetryFromUsage(result.usage) } : {}),
  };
}

export async function runTurn(
  request: ProviderInvocationRequest,
  cwd: string,
  options: CliOptions,
  identities: { conversationId: string; runId: string },
): Promise<CliResult> {
  const invocation = buildInvocation(request);
  const config = codexAcpConfig(request);
  const contextEnv = {
    ...(options.contextEnv ?? {}),
    ...codexAcpChildAuthEnv({ ...process.env, ...(options.contextEnv ?? {}) }),
    INITIAL_AGENT_MODE: initialAgentMode(request),
    ...(Object.keys(config).length > 0 ? { CODEX_CONFIG: JSON.stringify(config) } : {}),
  };
  const chatId = options.chatId;
  const redactionEnv = { ...process.env, ...contextEnv };
  const liveRedactor = createStreamingSecretRedactor(getProviderApiKeySecretValues(redactionEnv));
  const eventContext = options.eventContext;
  const onEvent = options.onEvent;
  let result;
  try {
    result = await runSupervisedStdioSession(
      invocation.command,
      invocation.args,
      cwd,
      { ...options, contextEnv, bot: options.bot ?? "codex" },
      async (io) => runAcpTurn({
        stream: nodeStdioStream(io.stdin as import("node:stream").Writable, io.stdout as import("node:stream").Readable),
        cwd,
        conversationId: identities.conversationId,
        runId: identities.runId,
        existingAcpSessionId: request.sessionId,
        prompt: promptBlocks(request),
        executionMode: request.executionMode,
        abortRequested: () => chatId != null && isAbortRequested(chatId),
        signal: io.signal,
        onLiveText: options.onProgress
          ? (text) => {
            const safe = liveRedactor.push(text);
            if (safe) options.onProgress?.(safe);
          }
          : undefined,
        // Forwarded as each ACP event arrives, not batched at turn completion,
        // so events observed before a cancellation/timeout/crash/provider
        // error are still persisted. Credentials are redacted per event before
        // it crosses the process boundary into the durable event sink.
        onEvent: eventContext && onEvent
          ? (event) => {
            if (!event.sessionMode) return;
            onEvent(bridgeEventType.acpEvent({
              runId: eventContext.runId,
              bot: eventContext.bot,
              chatId: eventContext.chatId,
              chatKey: eventContext.chatKey,
              threadId: eventContext.threadId,
              sessionId: event.acpSessionId ?? null,
              sessionMode: event.sessionMode,
              event: redactAcpEventCredentials(event, redactionEnv),
            }));
          }
          : undefined,
      }),
    );
  } catch (error) {
    throw redactAcpTurnError(error, redactionEnv);
  }
  const flushed = liveRedactor.flush();
  if (flushed) options.onProgress?.(flushed);
  const parsed = toCliResult(result);
  return {
    ...parsed,
    text: redactProviderApiKeySecrets(parsed.text, redactionEnv),
  };
}
