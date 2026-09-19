import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { EventStore } from "../src/events/store.js";
import { sendMessageWithProgress } from "../src/messageDelivery.js";
import { TELEGRAM_SURFACE_CAPABILITIES } from "../src/platform.js";

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
  it("durably retains and safely presents an actionable nested cause", async () => {
    const previous = process.env.CODEX_API_KEY;
    process.env.CODEX_API_KEY = "secret-diagnostic-key";
    const db = openDb(":memory:");
    try {
      const store = new EventStore(db);
      const client = createClient();
      const error = new Error("Internal error", {
        cause: new Error("bridge orchestration exploded with secret-diagnostic-key"),
      });

      const result = await sendMessageWithProgress({
        client,
        kind: "codex",
        chatId: -1003852297592,
        body: { message_thread_id: 86 },
        runId: "run-diag",
        onEvent: (event) => store.collect(event),
        execution: async () => { throw error; },
      });

      expect(result).toBeNull();
      const row = db.getEventsForRun("run-diag").find((event) => event.type === "run.diagnostic");
      expect(row).toBeDefined();
      const diagnostic = JSON.parse(row!.payload_json);
      expect(diagnostic).toMatchObject({
        type: "run.diagnostic",
        runId: "run-diag",
        bot: "codex",
        provider: "codex",
        chatId: "-1003852297592",
        chatKey: "-1003852297592:86",
        threadId: "86",
        boundary: "provider_execution",
        executionSurface: "message_delivery",
        attempt: 1,
        successorStarted: false,
        retryEligible: false,
        classification: "unknown",
        fallbackEligible: false,
      });
      expect(diagnostic.message).toContain("Internal error");
      expect(diagnostic.message).toContain("bridge orchestration exploded");
      expect(diagnostic.message).not.toContain("secret-diagnostic-key");
      expect(diagnostic.message).toContain("[REDACTED_PROVIDER_CREDENTIAL]");

      const delivered = client.sendMessage.mock.calls
        .map((call: any[]) => String(call[0]?.text ?? ""))
        .join("\n");
      expect(delivered).toContain("bridge orchestration exploded");
      expect(delivered).not.toContain("Internal error");
      expect(delivered).not.toContain("secret-diagnostic-key");
      expect(delivered).toContain("[REDACTED_PROVIDER_CREDENTIAL]");
    } finally {
      db.close();
      if (previous === undefined) delete process.env.CODEX_API_KEY;
      else process.env.CODEX_API_KEY = previous;
    }
  });
});


describe("interactive structured ACP failure delivery", () => {
  it("delivers data.details instead of a bare Internal error", async () => {
    const client = createClient();
    const error = Object.assign(new Error("Internal error"), {
      data: { details: "Could not find default localharness binary. Set ANTIGRAVITY_HARNESS_PATH." },
    });

    await sendMessageWithProgress({
      client,
      kind: "antigravity",
      chatId: 123,
      execution: async () => { throw error; },
    });

    const delivered = client.sendMessage.mock.calls
      .map((call: any[]) => String(call[0]?.text ?? ""))
      .join("\n");
    expect(delivered).toContain("localharness");
    expect(delivered).not.toContain("❌ Internal error");
  });

  it("delivers an explicit transport failure when structured detail is unavailable", async () => {
    const client = createClient();

    await sendMessageWithProgress({
      client,
      kind: "claude",
      chatId: 123,
      execution: async () => { throw new Error("ACP connection closed"); },
    });

    const delivered = client.sendMessage.mock.calls
      .map((call: any[]) => String(call[0]?.text ?? ""))
      .join("\n");
    expect(delivered).toContain("Provider connection failed; retry or inspect run diagnostics.");
    expect(delivered).not.toContain("Internal error");
  });
});
