/**
 * PURPOSE: Explicit, content-free evidence for live ACP logical-message qualification.
 * INPUTS: Settled ACP turn updates plus provider/session metadata.
 * OUTPUTS: A closed metadata record. Prompt text, answer text, tool payloads, and credentials are not fields.
 * NEIGHBORS: src/acp/logicalMessages.ts, src/acp/replay.ts, scripts/qualify-logical-messages.ts
 */

import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { AcpSessionMode, AcpTurnResult } from "./client.js";
import {
  createLogicalPreviewTextStream,
  reconstructLogicalMessages,
  renderLogicalMessages,
  type AcpBoundaryReason,
} from "./logicalMessages.js";
import type { AcpObservedUpdate } from "./replay.js";

const PROVIDERS = new Set(["codex", "claude", "agy", "grok", "cursor", "custom-acp"]);
const SESSION_UPDATES = new Set([
  "agent_message_chunk",
  "agent_thought_chunk",
  "user_message_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
  "available_commands_update",
  "current_mode_update",
  "config_option_update",
  "session_info_update",
  "usage_update",
]);
const CONTENT_TYPES = new Set(["text", "image", "audio", "resource", "resource_link"]);
const STOP_REASONS = new Set(["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"]);
const SESSION_MODES = new Set<AcpSessionMode>(["fresh", "load", "resume"]);
const BOUNDARIES = new Set<AcpBoundaryReason>(["message-id-change", "structural-event", "group-change"]);
const PHASES = new Set(["commentary", "final_answer"]);
const SAFE_TOKENS = [
  ...PROVIDERS,
  ...SESSION_UPDATES,
  ...CONTENT_TYPES,
  ...STOP_REASONS,
  ...SESSION_MODES,
  ...BOUNDARIES,
  ...PHASES,
  "live",
  "replay",
  "answer",
  "thought",
  "tool",
  "other",
  "unclassified",
];
const SAFE_STRING = new RegExp(`^(${SAFE_TOKENS.join("|")}|<(message|session|tool)-\\d+>)$`);

export class LogicalMessageQualificationLeak extends Error {
  constructor() {
    super("logical_message_qualification_retained_content");
    this.name = "LogicalMessageQualificationLeak";
  }
}

export interface LogicalMessageQualificationEvent {
  readonly sequence: number;
  readonly channel: "live" | "replay";
  readonly sessionUpdate: string;
  readonly category: "answer" | "thought" | "tool" | "other";
  readonly sameRootSession: boolean;
  readonly textChars: number;
  readonly contentType?: string;
  readonly messageIdPresent?: boolean;
  readonly messageIdAlias?: string;
  readonly phase?: "commentary" | "final_answer";
}

export interface LogicalMessageQualificationMessage {
  readonly index: number;
  readonly charCount: number;
  readonly selected: boolean;
  readonly messageIdPresent: boolean;
  readonly messageIdAlias?: string;
  readonly boundaryReason?: AcpBoundaryReason;
  readonly phase?: "commentary" | "final_answer";
}

export interface LogicalMessageQualificationTrace {
  readonly provider: string;
  readonly sessionMode: AcpSessionMode | "unclassified";
  readonly rootSessionAlias: string;
  readonly phaseAware: boolean;
  readonly eventCount: number;
  readonly categories: { readonly answer: number; readonly thought: number; readonly tool: number; readonly other: number };
  readonly messages: readonly LogicalMessageQualificationMessage[];
  readonly events: readonly LogicalMessageQualificationEvent[];
  readonly eventsTruncated: boolean;
  readonly previewCharCount: number;
  readonly finalCharCount: number;
  readonly previewFinalParity: boolean;
  readonly streamIntact: boolean;
  readonly terminal: { readonly observed: true; readonly stopReason: string };
  readonly cleanup: { readonly contentRetained: false; readonly durableTrace: false };
}

const EVENT_LIMIT = 400;

type AliasKind = "message" | "session" | "tool";

function aliasFactory(): (kind: AliasKind, value: string | undefined) => string | undefined {
  const maps = new Map<AliasKind, Map<string, string>>();
  return (kind, value) => {
    if (!value) return undefined;
    let bucket = maps.get(kind);
    if (!bucket) {
      bucket = new Map();
      maps.set(kind, bucket);
    }
    let alias = bucket.get(value);
    if (!alias) {
      alias = `<${kind}-${bucket.size + 1}>`;
      bucket.set(value, alias);
    }
    return alias;
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function codexPhase(meta: unknown): "commentary" | "final_answer" | undefined {
  const codex = asRecord(asRecord(meta)?.codex);
  const phase = codex?.phase;
  return phase === "commentary" || phase === "final_answer" ? phase : undefined;
}

function hasCodexMarker(meta: unknown): boolean {
  const record = asRecord(meta);
  return record !== undefined && Object.prototype.hasOwnProperty.call(record, "codex");
}

function updatePhase(update: SessionUpdate): "commentary" | "final_answer" | undefined {
  return codexPhase(asRecord(update)?._meta);
}

function textChars(update: SessionUpdate): number {
  if (!("content" in update)) return 0;
  const content = asRecord(update.content);
  return content?.type === "text" && typeof content.text === "string" ? content.text.length : 0;
}

function contentType(update: SessionUpdate): string | undefined {
  if (!("content" in update)) return undefined;
  const type = asRecord(update.content)?.type;
  return typeof type === "string" && CONTENT_TYPES.has(type) ? type : undefined;
}

function messageId(update: SessionUpdate): string | undefined {
  const id = asRecord(update)?.messageId;
  return typeof id === "string" && id !== "" ? id : undefined;
}

function category(sessionUpdate: string): LogicalMessageQualificationEvent["category"] {
  if (sessionUpdate === "agent_message_chunk") return "answer";
  if (sessionUpdate === "agent_thought_chunk") return "thought";
  if (sessionUpdate === "tool_call" || sessionUpdate === "tool_call_update") return "tool";
  return "other";
}

function sessionUpdateName(update: SessionUpdate): string {
  const name = update.sessionUpdate;
  return SESSION_UPDATES.has(name) ? name : "unclassified";
}

function liveRoot(updates: readonly AcpObservedUpdate[], sessionId: string): AcpObservedUpdate[] {
  return updates.filter((update) => update.channel === "live" && update.notification.sessionId === sessionId);
}

function phaseAwareTurn(updates: readonly AcpObservedUpdate[], sessionId: string): boolean {
  return liveRoot(updates, sessionId).some((update) => {
    if (update.notification.update.sessionUpdate !== "agent_message_chunk") return false;
    return hasCodexMarker(asRecord(update.notification.update)?._meta)
      || hasCodexMarker(asRecord(update.notification)?._meta);
  });
}

function previewCharCount(updates: readonly AcpObservedUpdate[], sessionId: string, phaseAware: boolean): number {
  const relevant = liveRoot(updates, sessionId);
  if (!phaseAware) {
    const next = createLogicalPreviewTextStream();
    return relevant.reduce((total, update) => total + next(update.notification.update).length, 0);
  }
  let phaseSemanticsSeen = false;
  let allowChunk = false;
  const next = createLogicalPreviewTextStream({
    groupOf: updatePhase,
    accept: () => allowChunk,
  });
  let total = 0;
  for (const update of relevant) {
    const payload = update.notification.update;
    const notificationMarker = hasCodexMarker(asRecord(update.notification)?._meta);
    const payloadMarker = hasCodexMarker(asRecord(payload)?._meta);
    if (notificationMarker || payloadMarker) phaseSemanticsSeen = true;
    allowChunk = false;
    if (payload.sessionUpdate === "agent_message_chunk" && payload.content.type === "text") {
      if (notificationMarker) allowChunk = false;
      else if (payloadMarker) allowChunk = updatePhase(payload) === "final_answer";
      else allowChunk = !phaseSemanticsSeen;
    }
    total += next(payload).length;
  }
  return total;
}

function finalCharCount(updates: readonly AcpObservedUpdate[], sessionId: string, phaseAware: boolean): number {
  const payloads = liveRoot(updates, sessionId).map((update) => update.notification.update);
  if (!phaseAware) return renderLogicalMessages(reconstructLogicalMessages(payloads)).length;
  const messages = reconstructLogicalMessages(payloads, { groupOf: updatePhase });
  return renderLogicalMessages(messages.filter((message) => message.group === "final_answer")).length;
}

function assertClosed(value: unknown): void {
  if (typeof value === "string") {
    if (!SAFE_STRING.test(value)) throw new LogicalMessageQualificationLeak();
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new LogicalMessageQualificationLeak();
    return;
  }
  if (typeof value === "boolean" || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const entry of value) assertClosed(entry);
    return;
  }
  if (asRecord(value)) {
    for (const entry of Object.values(value)) assertClosed(entry);
    return;
  }
  throw new LogicalMessageQualificationLeak();
}

export function assertQualificationTraceOmits(trace: LogicalMessageQualificationTrace, forbidden: readonly string[]): void {
  const serialized = JSON.stringify(trace);
  for (const value of forbidden) {
    if (value.length >= 12 && serialized.includes(value)) throw new LogicalMessageQualificationLeak();
  }
}

/** Metadata for one settled turn. The returned value never carries conversation content. */
export function buildLogicalMessageQualificationTrace(
  provider: string,
  result: Pick<AcpTurnResult, "updates" | "acpSessionId" | "stopReason" | "sessionMode">,
): LogicalMessageQualificationTrace {
  if (!PROVIDERS.has(provider)) throw new LogicalMessageQualificationLeak();
  const alias = aliasFactory();
  const rootSessionAlias = alias("session", result.acpSessionId) ?? "<session-1>";
  const phaseAware = phaseAwareTurn(result.updates, result.acpSessionId);
  const categories = { answer: 0, thought: 0, tool: 0, other: 0 };
  const events: LogicalMessageQualificationEvent[] = [];
  let sequence = 0;
  for (const update of result.updates) {
    sequence += 1;
    const payload = update.notification.update;
    const name = sessionUpdateName(payload);
    const kind = category(name);
    categories[kind] += 1;
    if (events.length >= EVENT_LIMIT) continue;
    const id = messageId(payload);
    const phase = updatePhase(payload);
    const type = contentType(payload);
    events.push({
      sequence,
      channel: update.channel,
      sessionUpdate: name,
      category: kind,
      sameRootSession: update.notification.sessionId === result.acpSessionId,
      textChars: textChars(payload),
      ...(type ? { contentType: type } : {}),
      ...(id ? { messageIdPresent: true, messageIdAlias: alias("message", id) } : {}),
      ...(phase ? { phase } : {}),
    });
  }
  const payloads = liveRoot(result.updates, result.acpSessionId).map((update) => update.notification.update);
  const reconstructed = reconstructLogicalMessages(payloads, phaseAware ? { groupOf: updatePhase } : {});
  const fragmentChars = payloads.reduce((total, update) => (
    update.sessionUpdate === "agent_message_chunk" ? total + textChars(update) : total
  ), 0);
  const messages: LogicalMessageQualificationMessage[] = reconstructed.map((message, index) => {
    const phase = message.group === "commentary" || message.group === "final_answer" ? message.group : undefined;
    return {
      index,
      charCount: message.text.length,
      selected: !phaseAware || message.group === "final_answer",
      messageIdPresent: Boolean(message.messageId),
      ...(message.messageId ? { messageIdAlias: alias("message", message.messageId) } : {}),
      ...(message.boundaryReason && BOUNDARIES.has(message.boundaryReason) ? { boundaryReason: message.boundaryReason } : {}),
      ...(phase && PHASES.has(phase) ? { phase } : {}),
    };
  });
  const preview = previewCharCount(result.updates, result.acpSessionId, phaseAware);
  const finalCount = finalCharCount(result.updates, result.acpSessionId, phaseAware);
  const trace: LogicalMessageQualificationTrace = {
    provider,
    sessionMode: SESSION_MODES.has(result.sessionMode) ? result.sessionMode : "unclassified",
    rootSessionAlias,
    phaseAware,
    eventCount: sequence,
    categories,
    messages,
    events,
    eventsTruncated: sequence > events.length,
    previewCharCount: preview,
    finalCharCount: finalCount,
    previewFinalParity: preview === finalCount,
    streamIntact: fragmentChars === reconstructed.reduce((total, message) => total + message.text.length, 0),
    terminal: {
      observed: true,
      stopReason: STOP_REASONS.has(result.stopReason) ? result.stopReason : "unclassified",
    },
    cleanup: { contentRetained: false, durableTrace: false },
  };
  assertClosed(trace);
  return trace;
}
