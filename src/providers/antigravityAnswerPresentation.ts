/**
 * Decode only Antigravity's structured user-visible answer deltas for preview
 * delivery. This module has no knowledge of tools, sessions, runs, or
 * completion state. Unknown and malformed protocol records fail closed.
 */

export interface AntigravityAnswerPresentationDecoder {
  readonly enabled: boolean;
  push(chunk: string): void;
  finish(): void;
}

const KNOWN_EVENT_TYPES = new Set(["init", "step_update", "result"]);
const KNOWN_STEP_TYPES = new Set(["user_input", "checkpoint", "agent_response", "tool"]);

function answerDelta(record: unknown): { known: boolean; text: string | null } {
  if (!record || typeof record !== "object" || Array.isArray(record)) return { known: false, text: null };
  const event = record as { event?: unknown };
  if (typeof event.event !== "string" || !KNOWN_EVENT_TYPES.has(event.event)) return { known: false, text: null };

  if (event.event === "init") {
    const init = record as { init?: unknown };
    if (!init.init || typeof init.init !== "object" || Array.isArray(init.init)) return { known: false, text: null };
    return { known: true, text: null };
  }

  if (event.event === "result") {
    const result = record as { result?: unknown };
    if (!result.result || typeof result.result !== "object" || Array.isArray(result.result)) return { known: false, text: null };
    const res = result.result as { status?: unknown };
    if (res.status !== "SUCCESS" && res.status !== "ERROR") return { known: false, text: null };
    return { known: true, text: null };
  }

  if (event.event === "step_update") {
    const stepUpdate = record as { step_update?: unknown };
    if (!stepUpdate.step_update || typeof stepUpdate.step_update !== "object" || Array.isArray(stepUpdate.step_update)) {
      return { known: false, text: null };
    }
    const update = stepUpdate.step_update as { step_type?: unknown; text_delta?: unknown };
    if (typeof update.step_type !== "string" || !KNOWN_STEP_TYPES.has(update.step_type)) {
      return { known: false, text: null };
    }
    return {
      known: true,
      text: update.step_type === "agent_response" && typeof update.text_delta === "string" ? update.text_delta : null,
    };
  }

  return { known: false, text: null };
}

export function createAntigravityAnswerPresentationDecoder(onDelta: (delta: string) => void): AntigravityAnswerPresentationDecoder {
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
