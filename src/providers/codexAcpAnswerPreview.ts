import type { AcpRetainedEvent } from "../acp/client.js";
import { createStreamingSecretRedactor } from "./streamingSecretRedactor.js";

type MetaCarrier = { _meta?: unknown };

function hasOwnCodexMarker(meta: unknown): boolean {
  return meta !== null
    && typeof meta === "object"
    && Object.prototype.hasOwnProperty.call(meta, "codex");
}

function validUpdatePhase(update: unknown): "commentary" | "final_answer" | undefined {
  if (update === null || typeof update !== "object") return undefined;
  const meta = (update as MetaCarrier)._meta;
  if (meta === null || typeof meta !== "object") return undefined;
  const codex = (meta as { codex?: unknown }).codex;
  if (codex === null || typeof codex !== "object") return undefined;
  const phase = (codex as { phase?: unknown }).phase;
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
): CodexAcpAnswerPreview {
  const redactor = createStreamingSecretRedactor(secrets);
  let phaseSemanticsSeen = false;

  const emit = (text: string): void => {
    const safe = redactor.push(text);
    if (safe) onAnswerDelta(safe);
  };

  return {
    observe(event): void {
      if (event.kind !== "session_update" || event.channel !== "live" || !event.notification) return;
      const notification = event.notification as typeof event.notification & MetaCarrier;
      const update = notification.update as typeof notification.update & MetaCarrier;
      const misplacedCodexMarker = hasOwnCodexMarker(notification._meta);
      const updateCodexMarker = hasOwnCodexMarker(update._meta);
      if (misplacedCodexMarker || updateCodexMarker) phaseSemanticsSeen = true;

      if (update.sessionUpdate !== "agent_message_chunk" || update.content.type !== "text") return;

      // A Codex marker on the notification envelope is misplaced. Its presence
      // is still explicit phase semantics, so fail closed for this and later
      // unphased chunks.
      if (misplacedCodexMarker) return;

      if (updateCodexMarker) {
        if (validUpdatePhase(update) === "final_answer") emit(update.content.text);
        return;
      }

      // ACP exposes thoughts on agent_thought_chunk, so an unphased live
      // agent_message_chunk is safe provisional answer text until Codex phase
      // semantics appear. After that point, missing phase is ambiguous.
      if (!phaseSemanticsSeen) emit(update.content.text);
    },

    finish(stopReason): void {
      // Cancellation abandons the transient preview. Never flush a buffered
      // secret prefix into UI that is about to be removed.
      if (stopReason === "cancelled") return;
      const safe = redactor.flush();
      if (safe) onAnswerDelta(safe);
    },
  };
}
