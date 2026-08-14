/**
 * Decode only Claude's structured user-visible answer deltas for preview
 * delivery. This module has no knowledge of tools, sessions, runs, or
 * completion state. Unknown and malformed protocol records fail closed.
 */

export interface ClaudeAnswerPresentationDecoder {
  readonly enabled: boolean;
  push(chunk: string): void;
  finish(): void;
}

const KNOWN_RECORD_TYPES = new Set(["system", "stream_event", "assistant", "result", "user"]);
const KNOWN_STREAM_EVENT_TYPES = new Set([
  "message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop",
]);
const KNOWN_DELTA_TYPES = new Set(["text_delta", "thinking_delta", "signature_delta", "input_json_delta"]);

function answerDelta(record: unknown): { known: boolean; text: string | null } {
  if (!record || typeof record !== "object" || Array.isArray(record)) return { known: false, text: null };
  const event = record as { type?: unknown; event?: unknown };
  if (typeof event.type !== "string" || !KNOWN_RECORD_TYPES.has(event.type)) return { known: false, text: null };
  if (event.type !== "stream_event") return { known: true, text: null };
  if (!event.event || typeof event.event !== "object" || Array.isArray(event.event)) return { known: false, text: null };
  const streamEvent = event.event as { type?: unknown; delta?: unknown };
  if (typeof streamEvent.type !== "string" || !KNOWN_STREAM_EVENT_TYPES.has(streamEvent.type)) return { known: false, text: null };
  if (streamEvent.type !== "content_block_delta") return { known: true, text: null };
  if (!streamEvent.delta || typeof streamEvent.delta !== "object" || Array.isArray(streamEvent.delta)) return { known: false, text: null };
  const delta = streamEvent.delta as { type?: unknown; text?: unknown };
  if (typeof delta.type !== "string" || !KNOWN_DELTA_TYPES.has(delta.type)) return { known: false, text: null };
  return { known: true, text: delta.type === "text_delta" && typeof delta.text === "string" ? delta.text : null };
}

export function createClaudeAnswerPresentationDecoder(onDelta: (delta: string) => void): ClaudeAnswerPresentationDecoder {
  let buffer = "";
  let enabled = true;

  const consume = (line: string): void => {
    if (!enabled || !line.trim()) return;
    try {
      const delta = answerDelta(JSON.parse(line));
      if (!delta.known) {
        enabled = false;
        return;
      }
      if (delta.text) onDelta(delta.text);
    } catch {
      enabled = false;
    }
  };

  return {
    get enabled() { return enabled; },
    push(chunk: string): void {
      if (!enabled) return;
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) consume(line.trim());
    },
    finish(): void {
      if (!enabled || !buffer.trim()) return;
      // A final unterminated fragment is not a complete JSONL record.
      buffer = "";
    },
  };
}
