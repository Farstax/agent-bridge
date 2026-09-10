import { afterEach, describe, expect, it, vi } from "vitest";
import { sendMessageWithProgress } from "../src/messageDelivery.js";
import { DISCORD_SURFACE_CAPABILITIES } from "../src/platform.js";
import type { CliResult } from "../src/types.js";

afterEach(() => vi.useRealTimers());

function createDiscordClient() {
  return {
    capabilities: DISCORD_SURFACE_CAPABILITIES,
    sendMessage: vi.fn(async () => ({ id: "discord-progress-1" })),
    sendChatAction: vi.fn(async () => null),
    editMessageText: vi.fn(async () => ({ id: "discord-progress-1" })),
    answerCallbackQuery: vi.fn(),
    setMyCommands: vi.fn(),
    sendDocument: vi.fn(),
    sendPhoto: vi.fn(),
  } as any;
}

describe("Discord structured run activity delivery", () => {
  it("uses the Discord message id and reconciles one transient message into the final answer", async () => {
    vi.useFakeTimers();
    const client = createDiscordClient();
    let finish!: () => void;
    const pending = sendMessageWithProgress({
      client,
      kind: "codex",
      chatId: "channel-1",
      execution: async (progress) => {
        progress.activity?.({ kind: "subagents", state: "working", activeCount: 2 });
        await new Promise<void>((resolve) => { finish = resolve; });
        return { text: "final answer", sessionId: "s1" } as CliResult;
      },
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    finish();
    await pending;
    expect(client.editMessageText).toHaveBeenCalledWith(expect.objectContaining({
      message_id: "discord-progress-1",
      text: "final answer",
    }));
  });

  it("neutralizes stale Discord activity when cancellation cannot delete messages", async () => {
    vi.useFakeTimers();
    const client = createDiscordClient();
    let aborted = false;
    const result = await sendMessageWithProgress({
      client,
      kind: "codex",
      chatId: "channel-1",
      isAborted: () => aborted,
      execution: async (progress) => {
        progress.activity?.({ kind: "subagents", state: "working", activeCount: 1 });
        await vi.advanceTimersByTimeAsync(0);
        aborted = true;
        return { text: "not delivered", sessionId: "s1" } as CliResult;
      },
    });

    expect(result).toBeNull();
    expect(client.editMessageText).toHaveBeenCalledWith(expect.objectContaining({
      message_id: "discord-progress-1",
      text: "Stopped.",
    }));
    expect(vi.getTimerCount()).toBe(0);
  });
});
