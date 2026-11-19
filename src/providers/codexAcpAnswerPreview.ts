import type { AcpRetainedEvent } from "../acp/client.js";
import { AcpLogicalMessageReconstructor, createLogicalPreviewTextStream } from "../acp/logicalMessages.js";
import { createStreamingSecretRedactor } from "./streamingSecretRedactor.js";

type MetaCarrier = { _meta?: unknown };
type CodexPhase = "commentary" | "final_answer";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function owns(value: Record<string, unknown> | null, key: string): boolean {
  return value !== null && Object.prototype.hasOwnProperty.call(value, key);
}

/** Recognize either supported metadata namespace, including malformed markers. */
export function hasCodexAcpPhaseMarker(meta: unknown): boolean {
  const root = record(meta);
  const jetbrains = record(root?.jetbrains);
  return owns(root, "codex") || owns(jetbrains, "air")
    || (owns(root, "jetbrains") && jetbrains === null);
}

/** The installed codex-acp adapter emits phases only under jetbrains.air. */
export function codexAcpUpdatePhase(update: unknown): CodexPhase | undefined {
  if (update === null || typeof update !== "object") return undefined;
  const root = record((update as MetaCarrier)._meta);
  if (!root) return undefined;
  const jetbrains = record(root.jetbrains);
  const hasLegacy = owns(root, "codex");
  const hasAir = owns(jetbrains, "air");
  // Conflicting metadata sources cannot authorize presenting text.
  if (hasLegacy && (hasAir || owns(root, "jetbrains"))) return undefined;
  let phase: unknown;
  if (hasAir) {
    const air = record(jetbrains?.air);
    if (air?.version !== 1) return undefined;
    phase = air.phase;
  } else if (hasLegacy) {
    phase = record(root.codex)?.phase;
  }
  return phase === "commentary" || phase === "final_answer" ? phase : undefined;
}

export interface CodexAcpAnswerPreview {
  observe(event: AcpRetainedEvent): void;
  finish(stopReason: string): void;
}

/**
 * Classifies Codex ACP session updates for provisional answer presentation.
 * This never participates in terminal-result authority: callers may display
 * emitted text transiently, but only the strict CliResult path owns completion.
 */
export function createCodexAcpAnswerPreview(
  onAnswerDelta: (text: string) => void,
  secrets: readonly string[],
  onCommentary?: (text: string, messageKey?: string) => void,
): CodexAcpAnswerPreview {
  const redactor = createStreamingSecretRedactor(secrets);
  let commentaryRedactor = createStreamingSecretRedactor(secrets);
  let phaseSemanticsSeen = false;
  let allowChunk = false;
  let commentaryText = "";
  let commentaryKey: string | undefined;
  let allowCommentary = false;
  const nextText = createLogicalPreviewTextStream({
    groupOf: (update) => codexAcpUpdatePhase(update),
    accept: () => allowChunk,
  });
  // Reuse ACP message boundaries, but never concatenate distinct commentary
  // messages into a single snapshot (the outward marker is single-line).
  const commentaryMessages = new AcpLogicalMessageReconstructor({
    groupOf: (update) => codexAcpUpdatePhase(update),
  });

  const emit = (text: string): void => {
    const safe = redactor.push(text);
    if (safe) onAnswerDelta(safe);
  };

  return {
    observe(event): void {
      if (event.presentationSuppressed) return;
      if (event.kind !== "session_update" || event.channel !== "live" || !event.notification) return;
      // Production retained events are tagged with the parent/root ACP session.
      // Native child notifications keep their own notification.sessionId and
      // must not contribute provisional parent answer text. Untagged synthetic
      // events retain legacy classifier behavior for isolated unit fixtures.
      if (event.acpSessionId && event.notification.sessionId !== event.acpSessionId) return;
      const notification = event.notification as typeof event.notification & MetaCarrier;
      const update = notification.update as typeof notification.update & MetaCarrier;
      const misplacedCodexMarker = hasCodexAcpPhaseMarker(notification._meta);
      const updateCodexMarker = hasCodexAcpPhaseMarker(update._meta);
      const answerChunk = update.sessionUpdate === "agent_message_chunk" && update.content.type === "text";
      // A session_info_update may carry Codex metadata without announcing
      // phase-aware answer text. Only an explicit phase or a malformed marker
      // on an answer chunk changes the safety classification.
      if (codexAcpUpdatePhase(update) !== undefined || (answerChunk && (misplacedCodexMarker || updateCodexMarker))) {
        phaseSemanticsSeen = true;
      }

      // Every parent-session update feeds boundary reconstruction; only the
      // decision below controls whether a text chunk may be shown.
      allowChunk = false;
      allowCommentary = false;
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
        // A Codex marker on the notification envelope is misplaced. Its presence
        // is still explicit phase semantics, so fail closed for this and later
        // unphased chunks.
        if (misplacedCodexMarker) allowChunk = false;
        else if (updateCodexMarker) {
          const phase = codexAcpUpdatePhase(update);
          allowChunk = phase === "final_answer";
          allowCommentary = phase === "commentary" && onCommentary !== undefined;
        }
        // ACP exposes thoughts on agent_thought_chunk, so an unphased live
        // agent_message_chunk is safe provisional answer text until Codex phase
        // semantics appear. After that point, missing phase is ambiguous.
        else allowChunk = !phaseSemanticsSeen;
      }
      const text = nextText(update);
      if (text) emit(text);
      const fragment = commentaryMessages.observe(update);
      if (fragment?.startsMessage) {
        // Do not flush a pending secret prefix across message boundaries.
        commentaryRedactor = createStreamingSecretRedactor(secrets);
        commentaryText = "";
        commentaryKey = undefined;
      }
      if (fragment && allowCommentary) {
        commentaryKey ??= String(fragment.messageIndex + 1);
        const safe = commentaryRedactor.push(fragment.text);
        if (safe) {
          commentaryText += safe;
          onCommentary?.(commentaryText, commentaryKey);
        }
      }
    },

    finish(stopReason): void {
      // Cancellation abandons the transient preview. Never flush a buffered
      // secret prefix into UI that is about to be removed.
      if (stopReason === "cancelled") return;
      const safe = redactor.flush();
      if (safe) onAnswerDelta(safe);
      const safeCommentary = commentaryRedactor.flush();
      if (safeCommentary) {
        commentaryText += safeCommentary;
        if (commentaryKey) onCommentary?.(commentaryText, commentaryKey);
      }
    },
  };
}
