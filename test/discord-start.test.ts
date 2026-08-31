import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { openDb } from "../src/db.js";
import { BridgeEngine } from "../src/engine.js";
import { resolveDiscordStartInteraction } from "../src/discordStart.js";
import { DISCORD_SURFACE_CAPABILITIES } from "../src/platform.js";

function interaction(payload: unknown, id = "123456789012345678"): any {
  return {
    id,
    type: 2,
    data: {
      name: "start",
      ...(payload === undefined ? {} : { options: [{ name: "payload", value: payload }] }),
    },
  };
}

function mockClient() {
  return {
    capabilities: DISCORD_SURFACE_CAPABILITIES,
    sendMessage: vi.fn().mockResolvedValue({ ok: true, result: { message_id: 1 } }),
    sendChatAction: vi.fn().mockResolvedValue({ ok: true }),
    editMessageText: vi.fn().mockResolvedValue({ ok: true }),
    answerCallbackQuery: vi.fn().mockResolvedValue({ ok: true }),
    sendDocument: vi.fn().mockResolvedValue({ ok: true }),
    sendPhoto: vi.fn().mockResolvedValue({ ok: true }),
  } as any;
}

describe("Discord /start ingress", () => {
  it("accepts bounded explicit context and preserves the interaction identity", () => {
    const result = resolveDiscordStartInteraction(interaction("incident-42"), {
      surfaceIdentity: "discord:interactive",
      chatKey: "channel:100",
      userId: "user:42",
      username: "Nick",
      chatType: "supergroup",
    });
    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") return;
    expect(result.turn.text).toBe("/start incident-42");
    expect(result.turn.messageId).toBe("123456789012345678");
    expect(result.turn).toMatchObject({ surfaceIdentity: "discord:interactive", chatKey: "channel:100", actorId: "user:42", delivery: { chatId: "channel:100", chatType: "supergroup" } });
  });

  it("preserves the normal /start readiness action when context is absent", () => {
    const result = resolveDiscordStartInteraction(interaction(undefined), { surfaceIdentity: "discord:interactive", chatKey: "channel:100", userId: "user:42" });
    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") return;
    expect(result.turn.text).toBe("/start");
  });

  it.each(["not safe", "x".repeat(65), "payload_with_underscore", { value: "bad" }])(
    "rejects malformed or oversized context (%j)",
    (payload) => {
      expect(resolveDiscordStartInteraction(interaction(payload), { surfaceIdentity: "discord:interactive", chatKey: "channel:100", userId: "user:42" })).toEqual({
        kind: "rejected",
        reason: "invalid_payload",
      });
    },
  );

  it("does not turn notification delivery or unrelated commands into execution", () => {
    expect(resolveDiscordStartInteraction({ type: "MESSAGE_CREATE", data: { content: "health alert" } }, { surfaceIdentity: "discord:interactive", chatKey: "channel:100", userId: "user:42" })).toEqual({
      kind: "rejected",
      reason: "invalid_payload",
    });
    expect(resolveDiscordStartInteraction({ type: 2, data: { name: "models" } }, { surfaceIdentity: "discord:interactive", chatKey: "channel:100", userId: "user:42" })).toEqual({
      kind: "rejected",
      reason: "invalid_payload",
    });
  });

  it("uses BridgeEngine's existing interaction identity claim for replay safety", async () => {
    const dbPath = join(tmpdir(), `discord-start-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    const db = openDb(dbPath);
    const runCli = vi.fn().mockResolvedValue("done");
    const client = mockClient();
    const engine = new BridgeEngine({
      surfaceIdentity: "discord:interactive",
      kind: "claude",
      botConfig: { command: "claude", modelPreference: [] },
      allowedUserIds: new Set(["42"]),
      executionMode: "safe",
      pollIntervalMs: 1000,
    }, db, client, { runCli });
    const resolved = resolveDiscordStartInteraction(interaction("incident-42"), { surfaceIdentity: "discord:interactive", chatKey: "channel:100", userId: "42" });
    expect(resolved.kind).toBe("accepted");
    if (resolved.kind !== "accepted") return;

    await engine.handleInteractiveTurn(resolved.turn);
    await engine.handleInteractiveTurn(resolved.turn);
    await new Promise((resolve) => setTimeout(resolve, 1_600));
    expect(runCli).toHaveBeenCalledOnce();
    db.close();
    rmSync(dbPath, { force: true });
  });
});
