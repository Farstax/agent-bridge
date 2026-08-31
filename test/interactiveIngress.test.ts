import { describe, expect, it, vi } from "vitest";
import { adaptDiscordMessage, adaptTelegramUpdate } from "../src/interactiveIngress.js";
import { DISCORD_SURFACE_CAPABILITIES, TELEGRAM_SURFACE_CAPABILITIES } from "../src/platform.js";
import { buildScheduledInteractiveTurn, type ScheduledRoutine } from "../src/scheduledRoutines.js";
import { DiscordClient } from "../src/discord.js";

function routine(overrides: Partial<ScheduledRoutine> = {}): ScheduledRoutine {
  return {
    id: "routine-1",
    name: "Morning priorities",
    instruction: "Review current work.",
    kind: "companion",
    surfaceIdentity: "telegram:interactive",
    chatKey: "-100:42",
    ownerKey: "owner:test",
    timezone: "Europe/London",
    schedule: { type: "weekly", weekdays: [1], time: "08:00" },
    enabled: true,
    createdAt: "2026-08-30T12:00:00.000Z",
    ...overrides,
  };
}

describe("surface-neutral interactive ingress", () => {
  it("keeps Discord snowflakes lossless and string-valued", () => {
    const turn = adaptDiscordMessage({
      id: "123456789012345678",
      channel_id: "223456789012345678",
      guild_id: "323456789012345678",
      author: { id: "423456789012345678", username: "owner" },
      content: "hello",
    }, "discord:interactive");
    expect(turn).toMatchObject({
      surfaceIdentity: "discord:interactive",
      chatKey: "223456789012345678",
      actorId: "423456789012345678",
      messageId: "123456789012345678",
      text: "hello",
      delivery: { chatId: "223456789012345678", chatType: "supergroup" },
    });
    expect(typeof turn?.delivery.chatId).toBe("string");
  });

  it("preserves Telegram topic identity while normalizing wire types once", () => {
    const turn = adaptTelegramUpdate({
      update_id: 7,
      message: {
        message_id: 8,
        chat: { id: -100123, type: "supergroup" },
        from: { id: 42, first_name: "owner" },
        message_thread_id: 99,
        text: "hello",
      },
    }, "telegram:interactive", "-100123:99");
    expect(turn).toEqual({
      surfaceIdentity: "telegram:interactive",
      chatKey: "-100123:99",
      actorId: "42",
      messageId: "8",
      text: "hello",
      threadId: "99",
      delivery: { chatId: -100123, chatType: "supergroup" },
      attachments: [],
    });
  });

  it("builds scheduled Telegram and Discord occurrences as the same neutral shape", () => {
    const telegram = buildScheduledInteractiveTurn(routine(), "2026-08-31T07:00:00.000Z", "123");
    expect(telegram).toMatchObject({ chatKey: "-100:42", actorId: "123", threadId: "42", delivery: { chatId: -100 } });

    const discord = buildScheduledInteractiveTurn(routine({ surfaceIdentity: "discord:interactive", chatKey: "223456789012345678" }), "2026-08-31T07:00:00.000Z", "423456789012345678");
    expect(discord).toMatchObject({ chatKey: "223456789012345678", actorId: "423456789012345678", delivery: { chatId: "223456789012345678" } });
    expect(typeof discord.delivery.chatId).toBe("string");
  });

  it("declares deterministic surface delivery capabilities and fails closed for unsupported Discord APIs", () => {
    expect(TELEGRAM_SURFACE_CAPABILITIES).toMatchObject({ maxMessageLength: 4096, editMessages: true, deleteMessages: true, previewStreaming: true, threads: true, formatting: "telegram-html" });
    expect(DISCORD_SURFACE_CAPABILITIES).toMatchObject({ maxMessageLength: 1990, editMessages: true, deleteMessages: false, previewStreaming: false, threads: false, formatting: "discord-markdown" });
    const client = new DiscordClient({ token: "tok", applicationId: "app", onUpdate: vi.fn() }, vi.fn() as any);
    expect(client.capabilities.polling).toBe(false);
    expect(client.capabilities.remoteFileDownload).toBe(false);
    expect((client as any).getUpdates).toBeUndefined();
    expect((client as any).getFilePath).toBeUndefined();
    expect((client as any).downloadFile).toBeUndefined();
  });
});
