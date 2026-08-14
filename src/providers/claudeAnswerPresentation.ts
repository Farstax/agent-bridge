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

function answerDelta(record: unknown): string | null {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const event = record as { type?: unknown; event?: unknown };
  if (event.type !== "stream_event" || !event.event || typeof event.event !== "object" || Array.isArray(event.event)) return null;
  const streamEvent = event.event as { type?: unknown; delta?: unknown };
  if (streamEvent.type !== "content_block_delta" || !streamEvent.delta || typeof streamEvent.delta !== "object" || Array.isArray(streamEvent.delta)) return null;
  const delta = streamEvent.delta as { type?: unknown; text?: unknown };
  if (delta.type !== "text_delta" || typeof delta.text !== "string") return null;
  return delta.text;
}

export function createClaudeAnswerPresentationDecoder(onDelta: (delta: string) => void): ClaudeAnswerPresentationDecoder {
  let buffer = "";
  let enabled = true;

  const consume = (line: string): void => {
    if (!enabled || !line.trim()) return;
    try {
      const delta = answerDelta(JSON.parse(line));
      if (delta) onDelta(delta);
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
