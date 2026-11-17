import type { SessionUpdate } from "@agentclientprotocol/sdk/unstable";
import { AcpLogicalMessageReconstructor } from "./logicalMessages.js";
import { createStreamingSecretRedactor } from "../providers/streamingSecretRedactor.js";

/**
 * Presentation-only interim commentary for opted-in outward ACP clients
 * (Desk). A logical assistant message is eligible only on protocol evidence
 * that it is not the final answer: Codex's explicit `commentary` phase closed
 * by the next message, or any message closed by a following root `tool_call`
 * (the turn continued, so it cannot be the last message). Thoughts, tool
 * content, `final_answer` text and the last message of a turn never qualify.
 * Anything that looks like a credential, code block or secret is dropped, not
 * redacted. Bridge's final-answer selection is unchanged and independent.
 */
export const INTERIM_COMMENTARY_META = "agent-bridge/interim-commentary";
export const INTERIM_COMMENTARY_MAX_CHARS = 280;
export const INTERIM_COMMENTARY_MAX_PER_ATTEMPT = 12;

export type InterimCommentarySignal = { id: string; text: string } | { clear: 1 };

const SENSITIVE: readonly RegExp[] = [
  /```/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
  /\b(?:password|passwd|secret|token|api[_-]?key|authorization|credential)s?\s*[:=]\s*\S{6,}/i,
  /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/,
  /[A-Za-z0-9_-]{40,}/,
];

type Phase = "commentary" | "final_answer";

function phaseOf(update: SessionUpdate): Phase | undefined {
  const codex = (update as { _meta?: { codex?: unknown } | null })._meta?.codex;
  const phase = codex !== null && typeof codex === "object" ? (codex as { phase?: unknown }).phase : undefined;
  return phase === "commentary" || phase === "final_answer" ? phase : undefined;
}

function sanitize(raw: string, secrets: readonly string[]): string | null {
  const text = raw.replace(/\s+/g, " ").trim();
  if (text.length < 2) return null;
  const redactor = createStreamingSecretRedactor(secrets);
  if (redactor.push(text) + redactor.flush() !== text) return null;
  if (SENSITIVE.some((pattern) => pattern.test(raw))) return null;
  if (text.length <= INTERIM_COMMENTARY_MAX_CHARS) return text;
  const cut = text.slice(0, INTERIM_COMMENTARY_MAX_CHARS - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > INTERIM_COMMENTARY_MAX_CHARS / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export interface InterimCommentary {
  /** Feed every live root-session update of the current provider attempt, in order. */
  observe(update: SessionUpdate): void;
  /** Provider retry/fallback, cancellation or settle: forget the attempt and clear anything shown. */
  reset(): void;
}

export function createInterimCommentary(
  emit: (signal: InterimCommentarySignal) => void,
  secrets: readonly string[],
): InterimCommentary {
  let reconstructor = new AcpLogicalMessageReconstructor({ groupOf: phaseOf });
  let considered = -1;
  let emitted = 0;
  let shown = false;

  const consider = (index: number, closedBy: "tool" | "next"): void => {
    if (index <= considered) return;
    considered = index;
    const message = reconstructor.messages[index];
    if (!message || message.group === "final_answer") return;
    // A message followed only by another message is eligible solely by explicit phase.
    if (closedBy === "next" && message.group !== "commentary") return;
    if (emitted >= INTERIM_COMMENTARY_MAX_PER_ATTEMPT) return;
    const safe = sanitize(message.text, secrets);
    if (!safe) return;
    emitted += 1;
    shown = true;
    emit({ id: String(emitted), text: safe });
  };

  return {
    observe(update) {
      if (update.sessionUpdate === "tool_call") {
        reconstructor.observe(update);
        if (reconstructor.messages.length > 0) consider(reconstructor.messages.length - 1, "tool");
        return;
      }
      const fragment = reconstructor.observe(update);
      if (fragment?.startsMessage && fragment.messageIndex > 0) consider(fragment.messageIndex - 1, "next");
    },
    reset() {
      reconstructor = new AcpLogicalMessageReconstructor({ groupOf: phaseOf });
      considered = -1;
      emitted = 0;
      if (!shown) return;
      shown = false;
      emit({ clear: 1 });
    },
  };
}
