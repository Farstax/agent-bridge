/**
 * PURPOSE: ACP-backed Codex runtime. Speaks ACP rather than parsing
 * Codex exec JSONL. Codex execution is ACP-only.
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
import { cleanOutputDir } from "../fileOutput.js";
import { appendOutputDirInstruction, wrapPromptContext } from "../promptWrapping.js";
import type { ProviderInvocation, ProviderInvocationRequest } from "./types.js";
import { resolveCodexAcpArgs, resolveCodexAcpCommand } from "./codexAcpConfig.js";
import {
  getProviderApiKeySecretValues,
  redactProviderApiKeySecrets,
} from "./apiKeyAuth.js";
import { createStreamingSecretRedactor } from "./streamingSecretRedactor.js";
import { createCodexAcpAnswerPreview } from "./codexAcpAnswerPreview.js";
import { createCodexAcpRunActivityProjector } from "./codexAcpRunActivity.js";
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

/**
 * Codex ACP's "agent" mode uses an "auto_review" approvals reviewer: the
 * adapter can self-approve actions it judges safe without ever asking Bridge
 * for a permission decision. That would let the provider silently expand its
 * own authority underneath Bridge's "safe" execution mode. "read-only" always
 * asks (approvalsReviewer: "user"), so every mutation/network request is
 * routed through Bridge's own mapAcpPermissionRequest instead.
 */
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

type CodexAgentMessageChunk =
  Extract<AcpObservedUpdate["notification"]["update"], { sessionUpdate: "agent_message_chunk" }>
  & { content: Extract<ContentBlock, { type: "text" }> };

type MetaCarrier = { _meta?: unknown };

function hasOwnCodexMarker(meta: unknown): boolean {
  return meta !== null
    && typeof meta === "object"
    && Object.prototype.hasOwnProperty.call(meta, "codex");
}

/**
 * Codex ACP tags agent_message_chunk notifications with `_meta.codex.phase`
 * ("commentary" | "final_answer"). Per the ACP v1 schema, `_meta` on a
 * SessionNotification (`notification._meta`) and `_meta` on the update
 * payload itself (`notification.update._meta`, via ContentChunk) are
 * distinct fields — Codex places its phase tag on the update payload, not
 * the notification envelope. This interpretation is Codex-specific and
 * deliberately lives here rather than in the generic ACP core. The generic
 * core scopes human-facing live text to the parent/root session before this
 * Codex phase policy is applied.
 */
function codexMetaOf(payload: CodexAgentMessageChunk): { phase?: unknown } | undefined {
  const meta = payload._meta as { codex?: unknown } | null | undefined;
  const codex = meta?.codex;
  return codex !== null && typeof codex === "object" ? codex as { phase?: unknown } : undefined;
}

/** Only a recognized phase value counts; a present-but-malformed value fails closed like a missing one. */
function codexPhaseOf(payload: CodexAgentMessageChunk): "commentary" | "final_answer" | undefined {
  const phase = codexMetaOf(payload)?.phase;
  return phase === "commentary" || phase === "final_answer" ? phase : undefined;
}

function liveAgentMessageChunk(
  update: AcpObservedUpdate,
  sessionId: string,
): CodexAgentMessageChunk | undefined {
  if (update.channel !== "live") return undefined;
  if (update.notification.sessionId !== sessionId) return undefined;
  const payload = update.notification.update;
  if (payload.sessionUpdate !== "agent_message_chunk" || payload.content.type !== "text") return undefined;
  return payload as CodexAgentMessageChunk;
}

/**
 * Presence is authoritative even when parsing is not. A malformed update-level
 * `_meta.codex` value, or a Codex marker placed on the notification envelope
 * instead of the update payload, is still unmistakably Codex phase semantics
 * and therefore disables generic liveText fallback. Only a turn with no Codex
 * marker at either relevant level may use generic live text.
 */
function hasCodexPhaseMarker(update: AcpObservedUpdate, payload: CodexAgentMessageChunk): boolean {
  if (hasOwnCodexMarker((payload as MetaCarrier)._meta)) return true;
  return hasOwnCodexMarker((update.notification as MetaCarrier)._meta);
}

/**
 * A turn "participates in Codex phase semantics" the moment any root-session
 * live chunk carries a Codex marker at the correct update level or at the
 * malformed notification-envelope level. Child-session phase markers never
 * influence parent answer authority. Once a turn is phase-aware, every root
 * chunk in it (commentary, missing phase, malformed phase, or misplaced phase)
 * fails closed out of the authoritative answer; only correctly located
 * "final_answer" chunks qualify. A turn with no root Codex phase marker keeps
 * the original generic behavior (every root live chunk is the answer).
 */
function turnHasCodexPhaseSemantics(
  updates: readonly AcpObservedUpdate[],
  sessionId: string,
): boolean {
  return updates.some((update) => {
    const payload = liveAgentMessageChunk(update, sessionId);
    return payload !== undefined && hasCodexPhaseMarker(update, payload);
  });
}

/**
 * The authoritative final answer for a phase-aware turn: only valid root
 * "final_answer" chunks, in original order. Replay and child sessions are
 * always excluded. Commentary, malformed phase, and missing-phase chunks are
 * all excluded — never promoted, never leaked into the delivered answer.
 */
function codexFinalAnswerText(
  updates: readonly AcpObservedUpdate[],
  sessionId: string,
): string {
  let text = "";
  for (const update of updates) {
    const payload = liveAgentMessageChunk(update, sessionId);
    if (!payload) continue;
    if (codexPhaseOf(payload) !== "final_answer") continue;
    text += payload.content.text;
  }
  return text;
}

export function toCliResult(result: AcpTurnResult): CliResult {
  const phaseAware = turnHasCodexPhaseSemantics(result.updates, result.acpSessionId);
  // Phase-aware turns never fall back to the raw live text — that would leak
  // commentary (or any malformed/missing-phase root chunk) as if it were the
  // authoritative answer. Child-session chunks are filtered before phase
  // semantics are considered. A phase-aware turn with no valid root
  // final_answer chunk yields empty text and hits the fail-closed guard below.
  const text = (
    phaseAware
      ? codexFinalAnswerText(result.updates, result.acpSessionId)
      : result.liveText
  ).trim();
  if (!text && result.stopReason !== "cancelled") {
    throw new Error(
      `Codex ACP completed without ${phaseAware ? "a valid final_answer chunk" : "live text"} (stopReason=${result.stopReason})`,
    );
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
  const secretValues = getProviderApiKeySecretValues(redactionEnv);
  const liveRedactor = createStreamingSecretRedactor(secretValues);
  const answerPreview = options.onAnswerDelta
    ? createCodexAcpAnswerPreview(options.onAnswerDelta, secretValues)
    : null;
  const activityProjector = options.onProgress?.activity
    ? createCodexAcpRunActivityProjector()
    : null;
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
        // Structured activity is projected before durable event persistence;
        // only safe state/count data crosses the presentation seam. Raw event
        // retention keeps its existing credential redaction and answer preview
        // authority remains separate.
        onEvent: answerPreview || activityProjector || (eventContext && onEvent)
          ? (event) => {
            const runActivity = activityProjector?.observe(event);
            if (runActivity) options.onProgress?.activity?.(runActivity);
            answerPreview?.observe(event);
            if (!eventContext || !onEvent || !event.sessionMode) return;
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
  answerPreview?.finish(result.stopReason);
  const parsed = toCliResult(result);
  if (parsed.stopReason === "cancelled" && request.outputDir) {
    try {
      await cleanOutputDir(request.outputDir);
    } catch (error) {
      console.warn("[codex] failed to clean output after ACP provider cancellation", error);
    }
  }
  return {
    ...parsed,
    text: redactProviderApiKeySecrets(parsed.text, redactionEnv),
  };
}
