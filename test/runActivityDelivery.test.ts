import { afterEach, describe, expect, it, vi } from "vitest";
import { sendMessageWithProgress } from "../src/messageDelivery.js";
import { TELEGRAM_SURFACE_CAPABILITIES } from "../src/platform.js";
import type { ProgressReporter, RunActivity } from "../src/runActivity.js";
import type { CliResult } from "../src/types.js";

function createClient() {
  let nextId = 100;
  return {
    capabilities: TELEGRAM_SURFACE_CAPABILITIES,
    sendMessage: vi.fn(async (body: any) => ({ ok: true, result: { message_id: ++nextId, ...body } })),
    sendChatAction: vi.fn(async () => ({ ok: true, result: true })),
    editMessageText: vi.fn(async () => ({ ok: true, result: true })),
    deleteMessage: vi.fn(async () => ({ ok: true, result: true })),
  } as any;
}

const delegated: RunActivity = { kind: "subagents", state: "delegated", activeCount: 1 };

afterEach(() => {
  vi.useRealTimers();
});

describe("structured run activity delivery", () => {
  it("keeps the parent typing heartbeat alive while a child works and reconciles progress into final", async () => {
    vi.useFakeTimers();
    const client = createClient();
    let finish!: () => void;
    const execution = async (progress: ProgressReporter): Promise<CliResult> => {
      progress.activity?.(delegated);
      await Promise.resolve();
      await new Promise<void>((resolve) => { finish = resolve; });
      return { text: "authoritative final", sessionId: "s1" };
    };

    const pending = sendMessageWithProgress({ client, kind: "codex", chatId: 123, execution });
    await vi.advanceTimersByTimeAsync(0);
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    expect(client.sendMessage.mock.calls[0][0].text).toBe("Delegated work to a subagent…");

    await vi.advanceTimersByTimeAsync(9_000);
    expect(client.sendChatAction).toHaveBeenCalledTimes(3);
    finish();
    await pending;

    expect(client.editMessageText).toHaveBeenCalledWith(expect.objectContaining({
      message_id: 101,
      text: expect.stringContaining("authoritative final"),
    }));
    const typingCount = client.sendChatAction.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(client.sendChatAction).toHaveBeenCalledTimes(typingCount);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("suppresses duplicate activity edits while retaining the latest bounded state", async () => {
    vi.useFakeTimers();
    const client = createClient();
    let finish!: () => void;
    const execution = async (progress: ProgressReporter): Promise<CliResult> => {
      progress.activity?.(delegated);
      await Promise.resolve();
      progress.activity?.(delegated);
      progress.activity?.({ kind: "subagents", state: "working", activeCount: 12 });
      progress.activity?.({ kind: "subagents", state: "working", activeCount: 12 });
      await new Promise<void>((resolve) => { finish = resolve; });
      return { text: "done", sessionId: "s1" };
    };

    const pending = sendMessageWithProgress({ client, kind: "codex", chatId: 123, execution });
    await vi.advanceTimersByTimeAsync(0);
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(700);
    expect(client.editMessageText).toHaveBeenCalledTimes(1);
    expect(client.editMessageText.mock.calls[0][0].text).toBe("9+ subagents working…");

    finish();
    await pending;
    expect(client.editMessageText).toHaveBeenCalledTimes(2);
  });

  it("removes transient child state before answer preview becomes visible", async () => {
    vi.useFakeTimers();
    const client = createClient();
    const pending = sendMessageWithProgress({
      client,
      kind: "codex",
      chatId: 123,
      allowAnswerPreview: true,
      execution: async (progress, onAnswerDelta) => {
        progress.activity?.(delegated);
        await vi.advanceTimersByTimeAsync(0);
        onAnswerDelta("safe answer");
        await vi.advanceTimersByTimeAsync(0);
        return { text: "safe answer", sessionId: "s1" } as CliResult;
      },
    });

    await pending;
    expect(client.deleteMessage).toHaveBeenCalledWith({ chat_id: 123, message_id: 101 });
    expect(client.sendMessage).toHaveBeenCalledTimes(2);
    expect(client.sendMessage.mock.calls[1][0].text).toContain("safe answer");
    expect(client.sendMessage.mock.calls[1][0].text).not.toContain("subagent");
  });

  it("cleans transient progress and typing on cancellation", async () => {
    vi.useFakeTimers();
    const client = createClient();
    let aborted = false;
    const result = await sendMessageWithProgress({
      client,
      kind: "codex",
      chatId: 123,
      isAborted: () => aborted,
      execution: async (progress) => {
        progress.activity?.(delegated);
        await vi.advanceTimersByTimeAsync(0);
        aborted = true;
        return { text: "must not deliver", sessionId: "s1" } as CliResult;
      },
    });

    expect(result).toBeNull();
    expect(client.deleteMessage).toHaveBeenCalledWith({ chat_id: 123, message_id: 101 });
    expect(client.editMessageText).not.toHaveBeenCalledWith(expect.objectContaining({ text: "must not deliver" }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores typing API failures and still terminates its only heartbeat", async () => {
    vi.useFakeTimers();
    const client = createClient();
    client.sendChatAction.mockRejectedValue(new Error("typing unavailable"));
    let finish!: () => void;
    const pending = sendMessageWithProgress({
      client,
      kind: "codex",
      chatId: 123,
      execution: async () => {
        await new Promise<void>((resolve) => { finish = resolve; });
        return { text: "done", sessionId: "s1" } as CliResult;
      },
    });

    await vi.advanceTimersByTimeAsync(4_500);
    expect(client.sendChatAction).toHaveBeenCalledTimes(2);
    finish();
    await pending;
    expect(vi.getTimerCount()).toBe(0);
  });
});
