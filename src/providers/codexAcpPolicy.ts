import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { AcpTurnResult } from "../acp/client.js";
import type { AcpObservedUpdate } from "../acp/replay.js";
import type { ProviderInvocationRequest } from "./types.js";
import type { AcpProviderPolicy } from "./acpRuntime.js";
import { resolveCodexAcpArgs, resolveCodexAcpCommand } from "./codexAcpConfig.js";
import { createCodexAcpAnswerPreview } from "./codexAcpAnswerPreview.js";

export class CodexAcpToolFreeUnsupportedError extends Error {
  constructor() {
    super(
      "Codex ACP cannot guarantee tool-free execution for toolMode \"none\": " +
      "the pinned adapter's read-only mode still permits read/search tools. Failing closed.",
    );
    this.name = "CodexAcpToolFreeUnsupportedError";
  }
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

type CodexAgentMessageChunk =
  Extract<AcpObservedUpdate["notification"]["update"], { sessionUpdate: "agent_message_chunk" }>
  & { content: Extract<ContentBlock, { type: "text" }> };
type MetaCarrier = { _meta?: unknown };

function hasOwnCodexMarker(meta: unknown): boolean {
  return meta !== null
    && typeof meta === "object"
    && Object.prototype.hasOwnProperty.call(meta, "codex");
}

function codexMetaOf(payload: CodexAgentMessageChunk): { phase?: unknown } | undefined {
  const meta = payload._meta as { codex?: unknown } | null | undefined;
  const codex = meta?.codex;
  return codex !== null && typeof codex === "object" ? codex as { phase?: unknown } : undefined;
}

function codexPhaseOf(payload: CodexAgentMessageChunk): "commentary" | "final_answer" | undefined {
  const phase = codexMetaOf(payload)?.phase;
  return phase === "commentary" || phase === "final_answer" ? phase : undefined;
}

function liveAgentMessageChunk(update: AcpObservedUpdate): CodexAgentMessageChunk | undefined {
  if (update.channel !== "live") return undefined;
  const payload = update.notification.update;
  if (payload.sessionUpdate !== "agent_message_chunk" || payload.content.type !== "text") return undefined;
  return payload as CodexAgentMessageChunk;
}

function hasCodexPhaseMarker(update: AcpObservedUpdate, payload: CodexAgentMessageChunk): boolean {
  if (hasOwnCodexMarker((payload as MetaCarrier)._meta)) return true;
  return hasOwnCodexMarker((update.notification as MetaCarrier)._meta);
}

function turnHasCodexPhaseSemantics(updates: readonly AcpObservedUpdate[]): boolean {
  return updates.some((update) => {
    const payload = liveAgentMessageChunk(update);
    return payload !== undefined && hasCodexPhaseMarker(update, payload);
  });
}

function codexFinalAnswerText(updates: readonly AcpObservedUpdate[]): string {
  let text = "";
  for (const update of updates) {
    const payload = liveAgentMessageChunk(update);
    if (!payload) continue;
    if (codexPhaseOf(payload) !== "final_answer") continue;
    text += payload.content.text;
  }
  return text;
}

export function selectCodexAcpAnswer(result: AcpTurnResult): { text: string; missingDescription: string } {
  const phaseAware = turnHasCodexPhaseSemantics(result.updates);
  return {
    text: (phaseAware ? codexFinalAnswerText(result.updates) : result.liveText).trim(),
    missingDescription: phaseAware ? "a valid final_answer chunk" : "live text",
  };
}

export const codexAcpPolicy: AcpProviderPolicy = {
  providerId: "codex",
  registryAgentId: "codex-acp",
  toolFree: false,
  presentation: {
    provisionalAnswers: true,
    createPreview: createCodexAcpAnswerPreview,
  },
  resolveExecutable: resolveCodexAcpCommand,
  resolveArgs: (env) => resolveCodexAcpArgs(env),
  buildChildEnv(request, env) {
    const config = codexAcpConfig(request);
    return {
      ...codexAcpChildAuthEnv(env),
      INITIAL_AGENT_MODE: initialAgentMode(request),
      ...(Object.keys(config).length > 0 ? { CODEX_CONFIG: JSON.stringify(config) } : {}),
    };
  },
  selectAnswer: selectCodexAcpAnswer,
};
