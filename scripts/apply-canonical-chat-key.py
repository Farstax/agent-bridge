#!/usr/bin/env python3
from pathlib import Path
import argparse
import re

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text()


def write(path: str, text: str) -> None:
    (ROOT / path).write_text(text)


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected 1 match, found {count}")
    return text.replace(old, new, 1)


def tests() -> None:
    path = ROOT / "test/canonicalConversationIdentity.test.ts"
    path.write_text(r'''import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { BridgeEngine } from "../src/engine.js";
import { EventStore } from "../src/events/store.js";
import { resolveUpdateChatKey } from "../src/interactiveBot.js";
import type { MessagingPlatform } from "../src/platform.js";
import type { TelegramUpdate } from "../src/types.js";

function fakePlatform(): MessagingPlatform {
  return {
    async getUpdates() { return { ok: true, result: [] }; },
    async sendMessage() { return { ok: true, result: { message_id: 1 } }; },
    async editMessageText() { return { ok: true, result: { message_id: 1 } }; },
    async sendChatAction() { return { ok: true, result: true }; },
    async answerCallbackQuery() { return { ok: true, result: true }; },
    async setMyCommands() { return { ok: true, result: true }; },
    async sendDocument() {},
    async sendPhoto() {},
    async getFilePath() { return ""; },
    async downloadFile() {},
  };
}

function resetUpdate(updateId: number): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: 1, type: "private" },
      from: { id: 7, first_name: "User" },
      text: "/reset",
    },
  };
}

describe("canonical conversation identity", () => {
  it("uses the surface-provided key even when two Discord channels share the old numeric alias", async () => {
    const db = openDb(":memory:", { serviceId: "canonical-chat-key-test" });
    try {
      const nativeA = "1";
      const nativeB = String(BigInt(Number.MAX_SAFE_INTEGER) + 1n);
      db.setSession(nativeA, "codex", "session-a");
      db.setSession(nativeB, "codex", "session-b");

      const engine = new BridgeEngine({
        kind: "codex",
        surfaceIdentity: "discord:interactive",
        botConfig: { command: "codex", modelPreference: ["default"] },
        allowedUserIds: new Set(["7"]),
        executionMode: "safe",
        asyncEnabled: false,
        pollIntervalMs: 1,
      }, db, fakePlatform());

      await (engine.handleUpdate as any)(resetUpdate(1), nativeB);
      expect(db.getSession(nativeB, "codex")).toBeNull();
      expect(db.getSession(nativeA, "codex")).toBe("session-a");

      await (engine.handleUpdate as any)(resetUpdate(2), nativeA);
      expect(db.getSession(nativeA, "codex")).toBeNull();
    } finally {
      db.close();
    }
  });

  it("persists and reconciles the authoritative key instead of rebuilding it from delivery fields", async () => {
    const db = openDb(":memory:", { serviceId: "canonical-event-key-test" });
    try {
      const nativeKey = "1234567890123456789";
      const store = new EventStore(db);
      store.collect({
        type: "run.started",
        version: 1,
        id: "event-1",
        runId: "run-native",
        timestamp: new Date(0).toISOString(),
        bot: "claude",
        chatId: "1",
        threadId: "99",
        chatKey: nativeKey,
        model: null,
        command: "claude",
        cwd: "/tmp",
      } as any);

      expect(db.getRun("run-native").chat_id).toBe(nativeKey);

      const destinations: string[] = [];
      await db.reconcileOrphanedRuns({
        nowMs: Date.now(),
        minAgeMs: 0,
        candidateRuns: [db.getRun("run-native")],
        processState: () => "absent",
        containmentState: () => "proven",
        onReconciled: (run) => { destinations.push(run.chat_id); },
      });
      expect(destinations).toEqual([nativeKey]);
    } finally {
      db.close();
    }
  });

  it("keeps Telegram topic addressing unchanged", () => {
    expect(resolveUpdateChatKey({
      update_id: 1,
      message: {
        message_id: 1,
        chat: { id: -1004366290625, type: "supergroup" },
        from: { id: 7, first_name: "User" },
        message_thread_id: 1458,
        text: "hello",
      },
    })).toBe("-1004366290625:1458");
  });
});
''')


def implementation() -> None:
    # CliOptions event context carries the authoritative conversation key.
    p = "src/types.ts"
    t = read(p)
    t = replace_once(
        t,
        'eventContext?: { runId: string; bot: "codex" | "antigravity" | "claude"; chatId: string; threadId?: string; serviceId?: string; acquisitionId?: string };',
        'eventContext?: { runId: string; bot: "codex" | "antigravity" | "claude"; chatId: string; chatKey: string; threadId?: string; serviceId?: string; acquisitionId?: string };',
        p,
    )
    write(p, t)

    # Every BridgeEvent owns the canonical key; delivery coordinates remain separate.
    p = "src/events/types.ts"
    t = read(p)
    t = replace_once(t, '  chatId: string;\n  threadId?: string;', '  chatId: string;\n  chatKey: string;\n  threadId?: string;', p + " base")
    t = replace_once(
        t,
        'function base(fields: { runId: string; bot: BotKind; chatId: string; threadId?: string }): BridgeEventBase {',
        'function base(fields: { runId: string; bot: BotKind; chatId: string; chatKey: string; threadId?: string }): BridgeEventBase {',
        p + " base fields",
    )
    t, n = re.subn(r'(    chatId: string;\n)(?!    chatKey:)', r'\1    chatKey: string;\n', t)
    if n != 5:
        raise RuntimeError(f"{p}: expected 5 event factory chatId fields, found {n}")
    write(p, t)

    # EventStore no longer reconstructs identity from transport fields.
    p = "src/events/store.ts"
    t = read(p)
    t, n = re.subn(r'function runChatKey\(event: \{ chatId: string; threadId\?: string \}\): string \{\n  return event\.threadId \? `\$\{event\.chatId\}:\$\{event\.threadId\}` : event\.chatId;\n\}\n\n', '', t)
    if n != 1:
        raise RuntimeError(f"{p}: runChatKey removal found {n}")
    if t.count('runChatKey(e)') != 2:
        raise RuntimeError(f"{p}: expected 2 reconstructed run keys")
    t = t.replace('runChatKey(e)', 'e.chatKey')
    write(p, t)

    # Provider telemetry uses the canonical event key too.
    p = "src/cli.ts"
    t = read(p)
    old = '''function eventChatKey(options: CliOptions): string | undefined {\n  const context = options.eventContext;\n  if (!context) return undefined;\n  return context.threadId ? `${context.chatId}:${context.threadId}` : context.chatId;\n}'''
    new = '''function eventChatKey(options: CliOptions): string | undefined {\n  return options.eventContext?.chatKey;\n}'''
    t = replace_once(t, old, new, p)
    write(p, t)

    # Interactive routing already owns chatKey; pass it through instead of dropping it.
    p = "src/interactiveBot.ts"
    t = read(p)
    t = replace_once(t, '  handleUpdate(update: TelegramUpdate): Promise<void>;', '  handleUpdate(update: TelegramUpdate, chatKey?: string): Promise<void>;', p + " interface")
    t = replace_once(t, '  else await engines[activeCli].handleUpdate(update);', '  else await engines[activeCli].handleUpdate(update, chatKey);', p + " dispatch")
    write(p, t)

    # BridgeEngine receives the surface key and threads it into all durable state and events.
    p = "src/engine.ts"
    t = read(p)
    t = replace_once(
        t,
        '''function topicChatKey(chatId: number, chatType: string, threadId?: number): string {\n  return threadId != null ? `${chatId}:${threadId}` : String(chatId);\n}\n''',
        '''function topicChatKey(chatId: number, chatType: string, threadId?: number): string {\n  return threadId != null ? `${chatId}:${threadId}` : String(chatId);\n}\n\nfunction telegramUpdateChatKey(update: TelegramUpdate): string | null {\n  const source = update.message ?? update.callback_query?.message;\n  if (!source?.chat) return null;\n  return topicChatKey(source.chat.id, source.chat.type ?? "private", source.message_thread_id);\n}\n''',
        p + " telegram ingress",
    )
    t = replace_once(
        t,
        '  private readonly seenTelegramMessageKeys = new Set<string>();',
        '  private readonly seenTelegramMessageKeys = new Set<string>();\n  private readonly messageChatKeys = new WeakMap<TelegramMessage, string>();',
        p + " map",
    )
    t = replace_once(
        t,
        '''      onFlush: (_groupId, messages) => {\n        return this.handleMessages(messages).catch((err) => {''',
        '''      onFlush: (_groupId, messages) => {\n        return this.handleMessages(messages, this.messageChatKeys.get(messages[0])).catch((err) => {''',
        p + " media",
    )
    t = replace_once(
        t,
        '''          this.handleUpdate(update).catch((error) => {\n            console.error(`[${this.kind}] update handling failed`, error);\n          });''',
        '''          const chatKey = telegramUpdateChatKey(update);\n          if (!chatKey) continue;\n          this.handleUpdate(update, chatKey).catch((error) => {\n            console.error(`[${this.kind}] update handling failed`, error);\n          });''',
        p + " run ingress",
    )
    t = replace_once(
        t,
        '''  async handleUpdate(update: TelegramUpdate): Promise<void> {\n    if (update.callback_query) {\n      await this.handleCallback(update.callback_query);\n      return;\n    }''',
        '''  async handleUpdate(update: TelegramUpdate, providedChatKey?: string): Promise<void> {\n    const chatKey = providedChatKey ?? telegramUpdateChatKey(update);\n    if (!chatKey) return;\n    if (update.callback_query) {\n      await this.handleCallback(update.callback_query, chatKey);\n      return;\n    }''',
        p + " handleUpdate",
    )
    t = replace_once(
        t,
        '''      const chatId = message.chat.id;\n      const threadId = message.message_thread_id;\n      const chatKey = topicChatKey(chatId, message.chat.type, threadId);''',
        '''      const chatId = message.chat.id;\n      const threadId = message.message_thread_id;''',
        p + " stop",
    )
    t = replace_once(t, '    await this.mediaBuffer.push(message);', '    this.messageChatKeys.set(message, chatKey);\n    await this.mediaBuffer.push(message);', p + " message key")
    t = replace_once(t, '  async handleMessages(messages: TelegramMessage[]): Promise<void> {', '  async handleMessages(messages: TelegramMessage[], providedChatKey?: string): Promise<void> {', p + " handleMessages")
    t = replace_once(
        t,
        '    const chatKey = topicChatKey(chatId, primaryMessage.chat.type, threadId);',
        '    const chatKey = providedChatKey ?? this.messageChatKeys.get(primaryMessage) ?? topicChatKey(chatId, primaryMessage.chat.type, threadId);',
        p + " message identity",
    )
    t = replace_once(t, 'this._createEventContext(chatId, threadId, laneHandle)', 'this._createEventContext(chatId, chatKey, threadId, laneHandle)', p + " event call")
    t = replace_once(
        t,
        '  private _createEventContext(chatId: number, threadId: number | undefined, laneHandle: ExecutionLaneHandle, existingRunId?: string): {',
        '  private _createEventContext(chatId: number, chatKey: string, threadId: number | undefined, laneHandle: ExecutionLaneHandle, existingRunId?: string): {',
        p + " event signature",
    )
    t = replace_once(
        t,
        '''      chatId: String(chatId),\n      threadId: threadId != null ? String(threadId) : undefined,''',
        '''      chatId: String(chatId),\n      chatKey,\n      threadId: threadId != null ? String(threadId) : undefined,''',
        p + " event value",
    )
    t = replace_once(t, '  async handleCallback(callbackQuery: TelegramCallbackQuery): Promise<void> {', '  async handleCallback(callbackQuery: TelegramCallbackQuery, providedChatKey?: string): Promise<void> {', p + " callback")
    callback_old = '''      const chatType = callbackQuery.message?.chat?.type ?? "private";\n      const threadId = callbackQuery.message?.message_thread_id;\n      if (!chatId || !messageId || !["augment", "interrupt", "queue", "reset"].includes(value)) return;\n      const chatKey = topicChatKey(chatId, chatType, threadId);'''
    callback_new = '''      const chatType = callbackQuery.message?.chat?.type ?? "private";\n      const threadId = callbackQuery.message?.message_thread_id;\n      if (!chatId || !messageId || !["augment", "interrupt", "queue", "reset"].includes(value)) return;\n      const chatKey = providedChatKey ?? topicChatKey(chatId, chatType, threadId);'''
    t = replace_once(t, callback_old, callback_new, p + " callback identity")
    write(p, t)

    # Discord uses native Snowflakes as the conversation key. Numeric IDs remain transport-only.
    p = "src/index-discord-interactive.ts"
    t = read(p)
    t = t.replace('import type { MessagingPlatform } from "./platform.js";\n', '')
    t = t.replace('import { discordLaneKey } from "./discordLaneKey.js";\n', '')
    t = replace_once(
        t,
        '''const engineAllowedUserIds = new Set<string>(allowedUserIds);\nfor (const id of allowedUserIds) {\n  engineAllowedUserIds.add(String(numericId(id)));\n}\n''',
        'const engineAllowedUserIds = new Set<string>(allowedUserIds);\n',
        p + " auth aliases",
    )
    pattern = r'const snowflakeAliases = new Map<string, string>\(\);\n\nclass DiscordEngineClient implements MessagingPlatform \{.*?\n\}\n\n// ── DiscordClient'
    t, n = re.subn(pattern, '// ── DiscordClient', t, flags=re.S)
    if n != 1:
        raise RuntimeError(f"{p}: DiscordEngineClient removal found {n}")
    t = t.replace('const engineClient = new DiscordEngineClient(client, snowflakeAliases);\n', '')
    t = t.replace('      engineClient,\n', '      client,\n')
    old_queue = '''  engine.setQueuedMessageHandler(async (queued) => {\n    return dispatchClaimedInteractiveWithFallback(queued, queued.chatKey, {\n      engines, fallbackChain, exhaustedChats, db,\n      notify: async (msg) => { await engineClient.sendMessage({ chat_id: queued.chatId, text: msg }); },'''
    new_queue = '''  engine.setQueuedMessageHandler(async (queued) => {\n    // pending_messages keeps legacy numeric delivery columns; the durable chatKey\n    // is authoritative, so restart recovery restores the native Discord destination.\n    const deliveryQueued = { ...queued, chatId: queued.chatKey as unknown as number };\n    return dispatchClaimedInteractiveWithFallback(deliveryQueued, deliveryQueued.chatKey, {\n      engines, fallbackChain, exhaustedChats, db,\n      notify: async (msg) => { await client.sendMessage({ chat_id: deliveryQueued.chatKey, text: msg }); },'''
    t = replace_once(t, old_queue, new_queue, p + " queued recovery")
    t = t.replace('rememberSnowflakeAlias(channelId)', 'channelId as unknown as number')
    t = t.replace('rememberSnowflakeAlias(authorId)', 'authorId as unknown as number')
    t = t.replace('rememberSnowflakeAlias(userId)', 'userId as unknown as number')
    if 'discordLaneKey(channelId)' not in t:
        raise RuntimeError(f"{p}: no Discord lane aliases found")
    t = t.replace('discordLaneKey(channelId)', 'channelId')
    t = replace_once(t, '.handleUpdate(resolution.update);', '.handleUpdate(resolution.update, channelId);', p + " start")
    t = replace_once(t, '    await engines[getUserCliPreference(db, chatKey)].handleUpdate(update);', '    await engines[getUserCliPreference(db, chatKey)].handleUpdate(update, chatKey);', p + " slash")
    utility_pattern = r'function rememberSnowflakeAlias\(snowflake: string\): number \{.*?\n\}\n\nfunction numericId\(snowflake: string\): number \{\n  return Number\(discordLaneKey\(snowflake\)\);\n\}'
    utility_repl = '''function numericId(snowflake: string): number {\n  // Discord update/message IDs only satisfy the Telegram-shaped adapter type.\n  // They are never used as conversation identity or durable routing keys.\n  const value = BigInt(snowflake || "0");\n  return Number(value % BigInt(Number.MAX_SAFE_INTEGER));\n}'''
    t, n = re.subn(utility_pattern, utility_repl, t, flags=re.S)
    if n != 1:
        raise RuntimeError(f"{p}: numeric transport utility replacement found {n}")
    if 'discordLaneKey' in t or 'snowflakeAliases' in t or 'engineClient' in t or 'rememberSnowflakeAlias' in t:
        raise RuntimeError(f"{p}: lossy Discord identity compatibility remains")
    write(p, t)

    # Existing EventStore tests now state the authoritative key explicitly.
    p = "test/eventStore.test.ts"
    t = read(p)
    t = t.replace('chatId: "100", command:', 'chatId: "100", chatKey: "100", command:')
    t = t.replace('chatId: "100", error:', 'chatId: "100", chatKey: "100", error:')
    t = t.replace('chatId: "100", reason:', 'chatId: "100", chatKey: "100", reason:')
    t = t.replace('chatId: "100", text:', 'chatId: "100", chatKey: "100", text:')
    t = replace_once(
        t,
        '''      chatId: "-1004366290625",\n      threadId: "1458",''',
        '''      chatId: "-1004366290625",\n      chatKey: "-1004366290625:1458",\n      threadId: "1458",''',
        p + " topic start",
    )
    t = replace_once(
        t,
        '''      chatId: "-1004366290625",\n      threadId: "3",''',
        '''      chatId: "-1004366290625",\n      chatKey: "-1004366290625:3",\n      threadId: "3",''',
        p + " topic terminal",
    )
    write(p, t)

    # The old alias helper and its implementation-shaped test are obsolete.
    for path in ("src/discordLaneKey.ts", "test/discordLaneKey.test.ts"):
        target = ROOT / path
        if target.exists():
            target.unlink()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["tests", "implementation"])
    args = parser.parse_args()
    if args.mode == "tests":
        tests()
    else:
        implementation()


if __name__ == "__main__":
    main()
