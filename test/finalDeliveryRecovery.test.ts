import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { BridgeEngine, type ProviderFallbackReason } from "../src/engine.js";
import { ProviderFallbackChain } from "../src/providerFallback.js";
import { lookupProviderSession } from "../src/providers/sessionRuntime.js";
import { dispatchClaimedInteractiveWithFallback, dispatchInteractiveWithFallback, setUserCliPreference } from "../src/interactiveBot.js";
import { sendMessageWithProgress, sendTelegramMessage } from "../src/messageDelivery.js";
import { TELEGRAM_SURFACE_CAPABILITIES } from "../src/platform.js";
import type { CliResult } from "../src/types.js";

const ANSWER = "the authoritative final answer";

function telegramRejection(status: number): Error {
  const error = new Error(`Telegram HTTP ${status}: Bad Request`) as any;
  error.status = status;
  return error;
}

function client(sendMessage: ReturnType<typeof vi.fn>) {
  return {
    capabilities: TELEGRAM_SURFACE_CAPABILITIES,
    sendMessage,
    sendChatAction: vi.fn(async () => ({ ok: true })),
    editMessageText: vi.fn(async () => ({ ok: true })),
    deleteMessage: vi.fn(async () => ({ ok: true })),
  } as any;
}

function answerTexts(sendMessage: ReturnType<typeof vi.fn>): string[] {
  return sendMessage.mock.calls.map(([body]: [any]) => String(body?.text ?? "")).filter((text) => text.includes("authoritative"));
}

async function deliver(options: {
  sendMessage: ReturnType<typeof vi.fn>;
  afterFinalDelivery?: () => void | Promise<void>;
  isAborted?: () => boolean;
  propagateExecutionError?: (error: Error) => boolean;
  retryDelays?: number[];
}) {
  const execution = vi.fn(async () => ({ text: ANSWER, sessionId: "s" } as CliResult));
  const result = await sendMessageWithProgress({
    client: client(options.sendMessage),
    kind: "codex",
    chatId: 100,
    execution,
    afterFinalDelivery: options.afterFinalDelivery,
    isAborted: options.isAborted,
    propagateExecutionError: options.propagateExecutionError,
    finalDeliveryRetryDelaysMs: options.retryDelays ?? [0, 0],
  } as any);
  return { result, execution };
}

describe("final-answer delivery recovery (#948)", () => {
  it("does not retry a deterministic rejection and says the answer was not delivered", async () => {
    const sendMessage = vi.fn(async (body: any) => {
      if (String(body?.text ?? "").includes("authoritative")) throw telegramRejection(403);
      return { ok: true, result: { message_id: 12 } };
    });
    const after = vi.fn();
    const { result } = await deliver({ sendMessage, afterFinalDelivery: after });
    expect(answerTexts(sendMessage)).toHaveLength(1);
    const notices = sendMessage.mock.calls.map(([b]: [any]) => String(b?.text ?? "")).filter((t) => /could not be delivered/i.test(t));
    expect(notices).toHaveLength(1);
    expect(after).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ text: ANSWER });
  });

  it("publishes and commits nothing when the Run is stopped while a retry is in flight", async () => {
    let stopped = false;
    let attempts = 0;
    const sendMessage = vi.fn(async (body: any) => {
      if (!String(body?.text ?? "").includes("authoritative")) return { ok: true, result: { message_id: 13 } };
      attempts += 1;
      if (attempts === 2) stopped = true;
      throw telegramRejection(429);
    });
    const after = vi.fn();
    const { result } = await deliver({ sendMessage, isAborted: () => stopped, afterFinalDelivery: after });
    expect(result).toBeNull();
    expect(after).not.toHaveBeenCalled();
    expect(sendMessage.mock.calls.map(([b]: [any]) => String(b?.text ?? "")).filter((t) => t.startsWith("⚠️"))).toHaveLength(0);
  });

  it("retries the same answer after a definite rejection without re-executing or routing to provider recovery", async () => {
    const sendMessage = vi.fn()
      .mockRejectedValueOnce(telegramRejection(429))
      .mockResolvedValue({ ok: true, result: { message_id: 7 } });
    const propagate = vi.fn(() => true);
    const after = vi.fn();
    const { result, execution } = await deliver({ sendMessage, afterFinalDelivery: after, propagateExecutionError: propagate });

    expect(execution).toHaveBeenCalledTimes(1);
    expect(answerTexts(sendMessage)).toHaveLength(2);
    expect(new Set(answerTexts(sendMessage)).size).toBe(1);
    expect(propagate).not.toHaveBeenCalled();
    expect(after).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ text: ANSWER });
  });

  it("does not turn a capacity-looking transport error into a provider fallback", async () => {
    const sendMessage = vi.fn(async () => { throw new Error("rate limit exceeded: usage limit reached"); });
    const propagate = vi.fn(() => true);
    const { result, execution } = await deliver({ sendMessage, propagateExecutionError: propagate });
    expect(execution).toHaveBeenCalledTimes(1);
    expect(propagate).not.toHaveBeenCalled();
    expect(result).toMatchObject({ text: ANSWER });
  });

  it("does not blindly resend when the acknowledgement is ambiguous, and reports uncertainty instead", async () => {
    const sendMessage = vi.fn()
      .mockRejectedValueOnce(new Error("ETIMEDOUT while waiting for sendMessage response"))
      .mockResolvedValue({ ok: true, result: { message_id: 8 } });
    const after = vi.fn();
    const { result } = await deliver({ sendMessage, afterFinalDelivery: after });

    expect(answerTexts(sendMessage)).toHaveLength(1);
    const notices = sendMessage.mock.calls.map(([b]: [any]) => String(b?.text ?? "")).filter((t) => /could not be confirmed/i.test(t));
    expect(notices).toHaveLength(1);
    expect(after).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ text: ANSWER });
  });

  it("stops after the bounded retries and still retires the executed turn exactly once", async () => {
    const sendMessage = vi.fn(async (body: any) => {
      if (String(body?.text ?? "").includes("authoritative")) throw telegramRejection(429);
      return { ok: true, result: { message_id: 9 } };
    });
    const after = vi.fn();
    const { result, execution } = await deliver({ sendMessage, afterFinalDelivery: after, retryDelays: [0, 0] });
    expect(execution).toHaveBeenCalledTimes(1);
    expect(answerTexts(sendMessage)).toHaveLength(3);
    expect(after).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ text: ANSWER });
  });

  it("does not resend after part of a multi-message answer was delivered", async () => {
    const partial = Object.assign(telegramRejection(429), { finalChunksDelivered: 1 });
    const sendMessage = vi.fn().mockRejectedValueOnce(partial).mockResolvedValue({ ok: true, result: { message_id: 10 } });
    await deliver({ sendMessage });
    expect(answerTexts(sendMessage)).toHaveLength(1);
  });

  it("never publishes once ownership is lost while a retry is pending", async () => {
    let aborted = false;
    const sendMessage = vi.fn(async () => {
      aborted = true;
      throw telegramRejection(429);
    });
    const after = vi.fn();
    const { result } = await deliver({ sendMessage, isAborted: () => aborted, afterFinalDelivery: after });
    expect(result).toBeNull();
    expect(answerTexts(sendMessage)).toHaveLength(1);
    expect(after).not.toHaveBeenCalled();
  });

  it("keeps a delivered answer and posts nothing more when only the commit step fails", async () => {
    const sendMessage = vi.fn(async () => ({ ok: true, result: { message_id: 11 } }));
    const after = vi.fn(async () => { throw new Error("socket hang up in commit"); });
    const propagate = vi.fn(() => true);
    const { result, execution } = await deliver({ sendMessage, afterFinalDelivery: after, propagateExecutionError: propagate });
    expect(execution).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls.map(([b]: [any]) => String(b?.text ?? "")).filter((t) => t.startsWith("❌"))).toHaveLength(0);
    expect(propagate).not.toHaveBeenCalled();
    expect(result).toMatchObject({ text: ANSWER });
  });
});

describe("final-answer delivery failure through BridgeEngine", () => {
  it("never invokes the provider a second time because delivery failed with a transient-looking error", async () => {
    const db = openDb(":memory:");
    try {
      const sendMessage = vi.fn(async () => { throw new Error("socket hang up"); });
      const runProviderInvocation = vi.fn(async () => ({ text: ANSWER, sessionId: "s1", stopReason: "end_turn" }));
      const fallbackRequests = new Map<string, ProviderFallbackReason>();
      const fallbackChain = new ProviderFallbackChain(["codex", "claude"], db, "telegram:interactive", () => true);
      const telegram = client(sendMessage);
      const engine = new BridgeEngine({
        surfaceIdentity: "telegram:interactive",
        kind: "codex",
        botConfig: { command: "codex", modelPreference: [] },
        allowedUserIds: new Set(["42"]),
        executionMode: "safe",
        busyMessageMode: "augment",
        pollIntervalMs: 1000,
        workingDir: process.cwd(),
        hooks: { onProviderFallbackRequested: async (key, reason) => { fallbackRequests.set(key, reason); } },
      }, db, telegram, { runProviderInvocation } as any);
      const deps = {
        engines: { codex: engine },
        fallbackChain,
        fallbackRequests,
        db,
        notify: async () => {},
      } as any;
      engine.setQueuedMessageHandler(async (queued) => dispatchClaimedInteractiveWithFallback(queued, queued.chatKey, deps));
      setUserCliPreference(db, { surfaceIdentity: "telegram:interactive", chatKey: "948" }, "codex");
      await dispatchInteractiveWithFallback({
        update_id: 948,
        message: { message_id: 1, chat: { id: 948, type: "private" }, from: { id: 42, first_name: "T" }, text: "do it" },
      }, "948", deps);
      expect(runProviderInvocation).toHaveBeenCalledTimes(1);
      expect(fallbackRequests.size).toBe(0);
      expect(db.pendingMsgCount("telegram:interactive", "948")).toBe(0);
      // The executed turn is committed even though nothing could be delivered.
      expect(lookupProviderSession(db, { surfaceIdentity: "telegram:interactive", chatKey: "948" }, "codex")).toBe("s1");
    } finally { db.close(); }
  });
});

describe("Discord message delivery failures surface as errors", () => {
  it("throws a definite-rejection error instead of reporting a rejected send as delivered", async () => {
    const { DiscordClient } = await import("../src/discord.js");
    const fetchFn = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({ message: "Missing Access", code: 50001 }) })) as any;
    const discord = new DiscordClient({ token: "t" } as any, fetchFn);
    await expect(discord.sendMessage({ chat_id: "1", text: "hello" })).rejects.toMatchObject({ status: 403 });
  });

  it("records how many chunks were already delivered when a later chunk is rejected", async () => {
    const { DiscordClient } = await import("../src/discord.js");
    let calls = 0;
    const fetchFn = vi.fn(async () => {
      calls += 1;
      return calls === 1
        ? { ok: true, status: 200, json: async () => ({ id: "m1" }) }
        : { ok: false, status: 400, json: async () => ({ message: "bad" }) };
    }) as any;
    const discord = new DiscordClient({ token: "t" } as any, fetchFn);
    await expect(discord.sendMessage({ chat_id: "1", text: "x".repeat(5000) }))
      .rejects.toMatchObject({ status: 400, finalChunksDelivered: 1 });
  });
});

describe("Telegram multi-message and rich-message delivery evidence", () => {
  it("annotates how many chunks were delivered when a later chunk fails", async () => {
    let calls = 0;
    const sendMessage = vi.fn(async () => {
      calls += 1;
      if (calls === 2) throw telegramRejection(429);
      return { ok: true, result: { message_id: calls } };
    });
    await expect(sendTelegramMessage({
      client: client(sendMessage),
      kind: "codex",
      chatId: 100,
      body: { text: `${"a".repeat(3900)}\n\n${"b".repeat(3900)}` },
    })).rejects.toMatchObject({ finalChunksDelivered: 1 });
  });

  it("does not fall back to a second send after an ambiguous rich-message failure", async () => {
    const sendRichMessage = vi.fn(async () => { throw new Error("ETIMEDOUT"); });
    const sendMessage = vi.fn(async () => ({ ok: true, result: { message_id: 1 } }));
    const rich = { ...client(sendMessage), sendRichMessage } as any;
    await expect(sendTelegramMessage({
      client: rich,
      kind: "codex",
      chatId: 100,
      body: { text: "| a | b |\n|---|---|\n| 1 | 2 |\n" },
    })).rejects.toThrow(/ETIMEDOUT/);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
