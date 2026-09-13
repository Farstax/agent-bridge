import { describe, expect, it, vi } from "vitest";
import { sendMessageWithProgress } from "../src/messageDelivery.js";
import { TELEGRAM_SURFACE_CAPABILITIES } from "../src/platform.js";
import type { BridgeEvent } from "../src/events/types.js";

function createClient() {
  return {
    capabilities: TELEGRAM_SURFACE_CAPABILITIES,
    sendMessage: vi.fn(async (body: any) => ({ ok: true, result: { message_id: 456, ...body } })),
    sendChatAction: vi.fn(async () => ({ ok: true, result: true })),
    editMessageText: vi.fn(async () => ({ ok: true, result: true })),
    deleteMessage: vi.fn(async () => ({ ok: true, result: true })),
    sendMessageDraft: vi.fn(async () => ({ ok: true })),
  } as any;
}

describe("interactive failure diagnostics", () => {
  it("persists the concrete redacted cause before presenting a generic internal error", async () => {
    const previous = process.env.CODEX_API_KEY;
    process.env.CODEX_API_KEY = "secret-diagnostic-key";
    try {
      const client = createClient();
      const events: BridgeEvent[] = [];
      const error = new Error("bridge orchestration exploded with secret-diagnostic-key", {
        cause: new Error("provider handoff failed"),
      });

      const result = await sendMessageWithProgress({
        client,
        kind: "codex",
        chatId: -1003852297592,
        body: { message_thread_id: 86 },
        runId: "run-diag",
        onEvent: (event) => events.push(event),
        execution: async () => { throw error; },
      });

      expect(result).toBeNull();
      const diagnostic = events.find((event) => event.type === "run.diagnostic") as any;
      expect(diagnostic).toMatchObject({
        runId: "run-diag",
        bot: "codex",
        chatId: "-1003852297592",
        chatKey: "-1003852297592:86",
        threadId: "86",
        boundary: "provider_execution",
        classification: "unknown",
        fallbackEligible: false,
      });
      expect(diagnostic.message).toContain("bridge orchestration exploded");
      expect(diagnostic.message).toContain("provider handoff failed");
      expect(diagnostic.message).not.toContain("secret-diagnostic-key");
      expect(diagnostic.message).toContain("[REDACTED]");

      const delivered = client.sendMessage.mock.calls.map((call: any[]) => String(call[0]?.text ?? "")).join("\n");
      expect(delivered).toContain("Internal error");
      expect(delivered).not.toContain("bridge orchestration exploded");
      expect(delivered).not.toContain("secret-diagnostic-key");
    } finally {
      if (previous === undefined) delete process.env.CODEX_API_KEY;
      else process.env.CODEX_API_KEY = previous;
    }
  });

  it("retains a diagnostic before a fallback-eligible execution error is rethrown", async () => {
    const client = createClient();
    const events: BridgeEvent[] = [];

    await expect(sendMessageWithProgress({
      client,
      kind: "codex",
      chatId: 123,
      runId: "run-capacity-diag",
      onEvent: (event) => events.push(event),
      execution: async () => { throw new Error("MODEL_CAPACITY_EXHAUSTED"); },
    })).rejects.toThrow("MODEL_CAPACITY_EXHAUSTED");

    expect(events.find((event) => event.type === "run.diagnostic")).toMatchObject({
      type: "run.diagnostic",
      runId: "run-capacity-diag",
      boundary: "provider_execution",
      classification: "capacity_exhausted",
      fallbackEligible: true,
    });
  });
});
