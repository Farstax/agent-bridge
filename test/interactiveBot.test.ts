/**
 * Tests for the interactive bot's CLI routing and /switch + /cli commands.
 */

import { afterEach, describe, it, expect, beforeEach, vi } from "vitest";
import { openDb } from "../src/db.js";
import type { BridgeDb } from "../src/db.js";
import type { TelegramUpdate } from "../src/types.js";
import { ProviderFallbackChain } from "../src/providerFallback.js";
import {
  getUserCliPreference,
  setUserCliPreference,
  buildCliStatusText,
  buildCliKeyboard,
  handleCliSwitchCallback,
  resolveUpdateChatKey,
  resolveMessageThreadId,
  isAuthorizedInteractiveUpdate,
  isCliCommandText,
  describeInteractiveUpdateForLog,
  buildInteractiveCommands,
  buildGlobalInteractiveCommandRegistrations,
  buildChatInteractiveCommandRegistrations,
  dispatchInteractiveWithFallback,
  applyManualCliSwitchHandoff,
  type CliKind,
} from "../src/interactiveBot.js";
import { isHandoffRequired } from "../src/handoffState.js";

const VALID_CLI_KINDS: CliKind[] = ["codex", "claude", "antigravity"];

beforeEach(() => {
  process.env.BRIDGE_LEGACY_MEMORY_COMPACTION_ENABLED = "true";
});

afterEach(() => {
  delete process.env.BRIDGE_LEGACY_MEMORY_COMPACTION_ENABLED;
});

describe("getUserCliPreference", () => {
  let db: BridgeDb;
  beforeEach(() => { db = openDb(":memory:"); });

  it("returns codex as default when no preference is stored", () => {
    expect(getUserCliPreference(db, "chat:1")).toBe("codex");
  });

  it("returns the stored preference after setUserCliPreference", () => {
    setUserCliPreference(db, "chat:1", "claude");
    expect(getUserCliPreference(db, "chat:1")).toBe("claude");
  });

  it("preferences are per chat_id", () => {
    setUserCliPreference(db, "chat:1", "claude");
    setUserCliPreference(db, "chat:2", "antigravity");
    expect(getUserCliPreference(db, "chat:1")).toBe("claude");
    expect(getUserCliPreference(db, "chat:2")).toBe("antigravity");
  });

  it("updating preference overwrites the previous value", () => {
    setUserCliPreference(db, "chat:1", "claude");
    setUserCliPreference(db, "chat:1", "codex");
    expect(getUserCliPreference(db, "chat:1")).toBe("codex");
  });
});


describe("buildCliStatusText", () => {
  it("names the active CLI", () => {
    for (const cli of VALID_CLI_KINDS) {
      expect(buildCliStatusText(cli)).toContain(cli);
    }
  });

  it("lists available CLIs", () => {
    const text = buildCliStatusText("codex");
    for (const cli of VALID_CLI_KINDS) {
      expect(text).toContain(cli);
    }
  });
});

describe("isCliCommandText", () => {
  it("matches bare /cli", () => {
    expect(isCliCommandText("/cli", "crawlerinteractivebot")).toBe(true);
  });

  it("matches group command suffix for this bot", () => {
    expect(isCliCommandText("/cli@crawlerinteractivebot", "crawlerinteractivebot")).toBe(true);
  });

  it("ignores group command suffix for a different bot", () => {
    expect(isCliCommandText("/cli@otherbot", "crawlerinteractivebot")).toBe(false);
  });
});

describe("describeInteractiveUpdateForLog", () => {
  it("summarizes group update metadata without message text", () => {
    const update: TelegramUpdate = {
      update_id: 10,
      message: {
        message_id: 20,
        chat: { id: -100123, type: "supergroup", title: "Ops" },
        from: { id: 77, first_name: "A", username: "alice" },
        text: "secret message body",
        message_thread_id: 42,
      },
    };

    expect(describeInteractiveUpdateForLog(update)).toEqual({
      updateId: 10,
      kind: "message",
      chatId: -100123,
      chatType: "supergroup",
      threadId: 42,
      fromId: 77,
      senderChatId: null,
      content: "text",
      contentDetail: "text",
    });
  });

  it("captures anonymous admin sender_chat metadata", () => {
    const update: TelegramUpdate = {
      update_id: 11,
      message: {
        message_id: 21,
        chat: { id: -100123, type: "supergroup", title: "Ops" },
        sender_chat: { id: -100123, type: "supergroup", title: "Ops" },
        text: "anonymous admin text",
      },
    };

    expect(describeInteractiveUpdateForLog(update)).toMatchObject({
      updateId: 11,
      chatId: -100123,
      fromId: null,
      senderChatId: -100123,
      content: "text",
      contentDetail: "text",
    });
  });

  it("names the subtype for non-text service messages", () => {
    const update: TelegramUpdate = {
      update_id: 12,
      message: {
        message_id: 22,
        chat: { id: -100123, type: "supergroup", title: "Ops" },
        from: { id: 77, first_name: "A" },
        new_chat_members: [{ id: 123, first_name: "Bot", is_bot: true }],
      } as any,
    };

    expect(describeInteractiveUpdateForLog(update)).toMatchObject({
      updateId: 12,
      content: "non_text",
      contentDetail: "new_chat_members",
    });
  });
});

// ── resolveUpdateChatKey ──────────────────────────────────────────────────────

describe("resolveUpdateChatKey", () => {
  it("returns chat id from message", () => {
    const update: TelegramUpdate = {
      update_id: 1,
      message: { message_id: 10, chat: { id: 123, type: "private" }, from: { id: 99, first_name: "A" }, text: "hello" },
    };
    expect(resolveUpdateChatKey(update)).toBe("123");
  });

  it("returns chat id from callback_query message", () => {
    const update: TelegramUpdate = {
      update_id: 2,
      callback_query: {
        id: "cbq1",
        from: { id: 99, first_name: "A" },
        message: { message_id: 5, chat: { id: 456, type: "private" } },
        data: "model:codex:o4-mini",
      },
    };
    expect(resolveUpdateChatKey(update)).toBe("456");
  });

  it("returns null when neither message nor callback_query present", () => {
    const update: TelegramUpdate = { update_id: 3 };
    expect(resolveUpdateChatKey(update)).toBeNull();
  });

  it("prefers message chat id when both are somehow present", () => {
    const update: TelegramUpdate = {
      update_id: 4,
      message: { message_id: 1, chat: { id: 111, type: "private" }, from: { id: 99, first_name: "A" }, text: "hi" },
      callback_query: {
        id: "cbq2",
        from: { id: 99, first_name: "A" },
        message: { message_id: 2, chat: { id: 222, type: "private" } },
        data: "model:codex:o4-mini",
      },
    };
    expect(resolveUpdateChatKey(update)).toBe("111");
  });

  it("includes thread id for group messages with message_thread_id", () => {
    const update: TelegramUpdate = {
      update_id: 5,
      message: {
        message_id: 20,
        chat: { id: 100, type: "supergroup" },
        from: { id: 99, first_name: "A" },
        text: "hi",
        message_thread_id: 42,
      },
    };
    expect(resolveUpdateChatKey(update)).toBe("100:42");
  });

  it("includes thread id for private topic messages", () => {
    const update: TelegramUpdate = {
      update_id: 6,
      message: {
        message_id: 21,
        chat: { id: 200, type: "private" },
        from: { id: 99, first_name: "A" },
        text: "hi",
        message_thread_id: 7,
      },
    };
    expect(resolveUpdateChatKey(update)).toBe("200:7");
  });

  it("keeps private topics independent across sessions, history, and CLI preferences", () => {
    const db = openDb(":memory:");
    const topic7: TelegramUpdate = {
      update_id: 61,
      message: {
        message_id: 21,
        chat: { id: 200, type: "private" },
        from: { id: 99, first_name: "A" },
        text: "topic seven",
        message_thread_id: 7,
      },
    };
    const topic8: TelegramUpdate = {
      update_id: 62,
      message: {
        message_id: 22,
        chat: { id: 200, type: "private" },
        from: { id: 99, first_name: "A" },
        text: "topic eight",
        message_thread_id: 8,
      },
    };
    const key7 = resolveUpdateChatKey(topic7)!;
    const key8 = resolveUpdateChatKey(topic8)!;

    try {
      db.setSession(key7, "codex", "session-7");
      db.setSession(key8, "codex", "session-8");
      db.addConvTurn(key7, "user", "history-7");
      db.addConvTurn(key8, "user", "history-8");
      setUserCliPreference(db, key7, "codex");
      setUserCliPreference(db, key8, "claude");

      expect(db.getSession(key7, "codex")).toBe("session-7");
      expect(db.getSession(key8, "codex")).toBe("session-8");
      expect(db.getRecentConvTurns(key7, 10).map((turn) => turn.text)).toEqual(["history-7"]);
      expect(db.getRecentConvTurns(key8, 10).map((turn) => turn.text)).toEqual(["history-8"]);
      expect(getUserCliPreference(db, key7)).toBe("codex");
      expect(getUserCliPreference(db, key8)).toBe("claude");
    } finally {
      db.close();
    }
  });

  it("returns plain chat id for group messages without a thread", () => {
    const update: TelegramUpdate = {
      update_id: 7,
      message: {
        message_id: 22,
        chat: { id: 300, type: "group" },
        from: { id: 99, first_name: "A" },
        text: "hi",
      },
    };
    expect(resolveUpdateChatKey(update)).toBe("300");
  });

  it("includes thread id for callback_query in a supergroup thread", () => {
    const update: TelegramUpdate = {
      update_id: 8,
      callback_query: {
        id: "cbq3",
        from: { id: 99, first_name: "A" },
        message: { message_id: 30, chat: { id: 500, type: "supergroup" }, message_thread_id: 77 },
        data: "cli:claude",
      },
    };
    expect(resolveUpdateChatKey(update)).toBe("500:77");
  });

  it("returns plain chat id for callback_query without a thread", () => {
    const update: TelegramUpdate = {
      update_id: 9,
      callback_query: {
        id: "cbq4",
        from: { id: 99, first_name: "A" },
        message: { message_id: 31, chat: { id: 600, type: "supergroup" } },
        data: "cli:codex",
      },
    };
    expect(resolveUpdateChatKey(update)).toBe("600");
  });
});

// ── resolveMessageThreadId ────────────────────────────────────────────────────

describe("resolveMessageThreadId", () => {
  it("returns message_thread_id from a group message", () => {
    const update: TelegramUpdate = {
      update_id: 1,
      message: {
        message_id: 1,
        chat: { id: 100, type: "supergroup" },
        from: { id: 99, first_name: "A" },
        text: "hi",
        message_thread_id: 42,
      },
    };
    expect(resolveMessageThreadId(update)).toBe(42);
  });

  it("returns undefined for a private message", () => {
    const update: TelegramUpdate = {
      update_id: 2,
      message: {
        message_id: 2,
        chat: { id: 200, type: "private" },
        from: { id: 99, first_name: "A" },
        text: "hi",
      },
    };
    expect(resolveMessageThreadId(update)).toBeUndefined();
  });

  it("returns message_thread_id from callback_query message in a group thread", () => {
    const update: TelegramUpdate = {
      update_id: 3,
      callback_query: {
        id: "cbq1",
        from: { id: 99, first_name: "A" },
        message: { message_id: 5, chat: { id: 300, type: "supergroup" }, message_thread_id: 99 },
        data: "cli:claude",
      },
    };
    expect(resolveMessageThreadId(update)).toBe(99);
  });

  it("returns undefined when no update has a thread", () => {
    const update: TelegramUpdate = { update_id: 4 };
    expect(resolveMessageThreadId(update)).toBeUndefined();
  });
});

// ── isAuthorizedInteractiveUpdate ─────────────────────────────────────────────

describe("isAuthorizedInteractiveUpdate", () => {
  const allowed = new Set(["99"]);

  it("allows message from an authorized user", () => {
    const update: TelegramUpdate = {
      update_id: 1,
      message: { message_id: 1, chat: { id: 1, type: "private" }, from: { id: 99, first_name: "A" }, text: "hi" },
    };
    expect(isAuthorizedInteractiveUpdate(update, allowed)).toBe(true);
  });

  it("rejects message from an unauthorized user", () => {
    const update: TelegramUpdate = {
      update_id: 2,
      message: { message_id: 2, chat: { id: 1, type: "private" }, from: { id: 77, first_name: "X" }, text: "hi" },
    };
    expect(isAuthorizedInteractiveUpdate(update, allowed)).toBe(false);
  });

  it("allows callback_query from an authorized user", () => {
    const update: TelegramUpdate = {
      update_id: 3,
      callback_query: {
        id: "cbq1",
        from: { id: 99, first_name: "A" },
        message: { message_id: 5, chat: { id: 1, type: "private" } },
        data: "model:codex:o4-mini",
      },
    };
    expect(isAuthorizedInteractiveUpdate(update, allowed)).toBe(true);
  });

  it("rejects callback_query from an unauthorized user", () => {
    const update: TelegramUpdate = {
      update_id: 4,
      callback_query: {
        id: "cbq2",
        from: { id: 77, first_name: "X" },
        message: { message_id: 6, chat: { id: 1, type: "private" } },
        data: "model:codex:o4-mini",
      },
    };
    expect(isAuthorizedInteractiveUpdate(update, allowed)).toBe(false);
  });

  it("rejects an update with no message and no callback_query", () => {
    const update: TelegramUpdate = { update_id: 5 };
    expect(isAuthorizedInteractiveUpdate(update, allowed)).toBe(false);
  });
});

// ── buildInteractiveCommands ──────────────────────────────────────────────────

describe("buildInteractiveCommands", () => {
  it("includes /cli command", () => {
    const cmds = buildInteractiveCommands("codex");
    expect(cmds.some(c => c.command === "cli")).toBe(true);
  });

  it("does not include /switch command — /cli handles switching via keyboard", () => {
    for (const pref of VALID_CLI_KINDS) {
      expect(buildInteractiveCommands(pref).some(c => c.command === "switch")).toBe(false);
    }
  });

  it("includes underlying CLI commands (/models, /reset) but not skills or memory", () => {
    const cmds = buildInteractiveCommands("claude");
    const names = cmds.map(c => c.command);
    expect(names).toContain("models");
    expect(names).toContain("reset");
    expect(names).not.toContain("skills");
    expect(names).not.toContain("memory");
  });

  it("includes /usage only when pref is codex", () => {
    const codexCmds = buildInteractiveCommands("codex").map(c => c.command);
    const claudeCmds = buildInteractiveCommands("claude").map(c => c.command);
    expect(codexCmds).toContain("usage");
    expect(claudeCmds).not.toContain("usage");
  });

  it("has no duplicate command names", () => {
    for (const pref of VALID_CLI_KINDS) {
      const names = buildInteractiveCommands(pref).map(c => c.command);
      expect(new Set(names).size).toBe(names.length);
    }
  });
});

// ── command registration scopes ───────────────────────────────────────────────

describe("interactive command registration scopes", () => {
  it("registers /health only when the interactive bot owns integrated health commands", () => {
    expect(buildInteractiveCommands("codex").map((command) => command.command)).not.toContain("health");
    expect(buildInteractiveCommands("codex", { integratedHealth: true }).map((command) => command.command)).toContain("health");
  });

  it("registers global private, group, and group-admin command scopes", () => {
    const registrations = buildGlobalInteractiveCommandRegistrations("codex");
    expect(registrations.map((r) => r.scope?.type ?? "default")).toEqual([
      "default",
      "all_group_chats",
      "all_chat_administrators",
    ]);
  });

  it("registers chat and chat-admin command scopes for a specific group", () => {
    const registrations = buildChatInteractiveCommandRegistrations("claude", -100123);
    expect(registrations.map((r) => r.scope)).toEqual([
      { type: "chat", chat_id: -100123 },
      { type: "chat_administrators", chat_id: -100123 },
    ]);
  });
});

// ── buildCliKeyboard ──────────────────────────────────────────────────────────

describe("buildCliKeyboard", () => {
  it("returns an inline_keyboard with one row per CLI kind", () => {
    const kb = buildCliKeyboard("codex");
    expect(kb.inline_keyboard).toHaveLength(3);
  });

  it("marks the active CLI with a checkmark", () => {
    const kb = buildCliKeyboard("claude");
    const allButtons = kb.inline_keyboard.flat();
    const active = allButtons.find((b) => b.text.includes("✓"));
    expect(active).toBeDefined();
    expect(active!.text).toContain("claude");
  });

  it("does not mark inactive CLIs with a checkmark", () => {
    const kb = buildCliKeyboard("codex");
    const allButtons = kb.inline_keyboard.flat();
    const checked = allButtons.filter((b) => b.text.includes("✓"));
    expect(checked).toHaveLength(1);
    expect(checked[0].text).toContain("codex");
  });

  it("callback_data encodes the CLI kind for each button", () => {
    const kb = buildCliKeyboard("codex");
    const allButtons = kb.inline_keyboard.flat();
    expect(allButtons.every((b) => b.callback_data.startsWith("cli:"))).toBe(true);
    for (const cli of VALID_CLI_KINDS) {
      expect(allButtons.some((b) => b.callback_data === `cli:${cli}`)).toBe(true);
    }
  });

  it("all callback_data values are under 64 bytes", () => {
    for (const pref of VALID_CLI_KINDS) {
      const kb = buildCliKeyboard(pref);
      for (const row of kb.inline_keyboard) {
        for (const btn of row) {
          expect(Buffer.byteLength(btn.callback_data, "utf8")).toBeLessThan(64);
        }
      }
    }
  });
});

// ── handleCliSwitchCallback ───────────────────────────────────────────────────

describe("handleCliSwitchCallback", () => {
  it("parses cli:codex → codex", () => {
    expect(handleCliSwitchCallback("cli:codex")).toBe("codex");
  });

  it("parses cli:claude → claude", () => {
    expect(handleCliSwitchCallback("cli:claude")).toBe("claude");
  });

  it("parses cli:antigravity → antigravity", () => {
    expect(handleCliSwitchCallback("cli:antigravity")).toBe("antigravity");
  });

  it("returns null for unrecognized prefix", () => {
    expect(handleCliSwitchCallback("model:codex:gpt4")).toBeNull();
  });

  it("returns null for cli: with unknown kind", () => {
    expect(handleCliSwitchCallback("cli:gpt")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(handleCliSwitchCallback("")).toBeNull();
  });
});

// ── dispatchInteractiveWithFallback ───────────────────────────────────────────

describe("dispatchInteractiveWithFallback", () => {
  let db: BridgeDb;
  let codex: { handleUpdate: any; handleCount: number };
  let claude: { handleUpdate: any; handleCount: number };
  let antigravity: { handleUpdate: any; handleCount: number };
  let fallbackChain: ProviderFallbackChain;
  let exhaustedChats: Set<string>;
  let sentMessages: string[];
  let onCliSwitchedCalls: CliKind[];

  beforeEach(() => {
    db = openDb(":memory:");
    codex = { handleCount: 0, handleUpdate: async () => { codex.handleCount++; } };
    claude = { handleCount: 0, handleUpdate: async () => { claude.handleCount++; } };
    antigravity = { handleCount: 0, handleUpdate: async () => { antigravity.handleCount++; } };
    fallbackChain = new ProviderFallbackChain(["codex", "claude", "antigravity"], db);
    exhaustedChats = new Set();
    sentMessages = [];
    onCliSwitchedCalls = [];
  });

  const deps = () => ({
    engines: { codex, claude, antigravity },
    fallbackChain,
    exhaustedChats,
    db,
    notify: (msg: string) => { sentMessages.push(msg); },
    onCliSwitched: async (newCli: CliKind) => { onCliSwitchedCalls.push(newCli); },
  });

  it("routes to the user's preferred CLI from DB", async () => {
    setUserCliPreference(db, "chat:1", "claude");
    await dispatchInteractiveWithFallback({ update_id: 1, message: { text: "hello", chat: { id: 1 } } } as any, "chat:1", deps());
    expect(claude.handleCount).toBe(1);
    expect(codex.handleCount).toBe(0);
  });

  it("automatically falls back to the next CLI when exhausted", async () => {
    setUserCliPreference(db, "chat:1", "codex");
    codex.handleUpdate = async () => {
      codex.handleCount++;
      exhaustedChats.add("chat:1");
    };

    await dispatchInteractiveWithFallback({ update_id: 1, message: { text: "hello", chat: { id: 1 } } } as any, "chat:1", deps());

    expect(codex.handleCount).toBe(1);
    expect(claude.handleCount).toBe(1);
    expect(getUserCliPreference(db, "chat:1")).toBe("claude");
    expect(sentMessages).toContain("Switching to claude (codex at capacity)");
    expect(onCliSwitchedCalls).toContain("claude");
  });

  it("auto-fallback promotes the successful fallback CLI into the stored DB preference", async () => {
    setUserCliPreference(db, "chat:1", "codex");
    codex.handleUpdate = async () => {
      codex.handleCount++;
      exhaustedChats.add("chat:1");
    };

    await dispatchInteractiveWithFallback({ update_id: 1, message: { text: "hello", chat: { id: 1 } } } as any, "chat:1", deps());

    expect(onCliSwitchedCalls).toContain("claude");
    expect(getUserCliPreference(db, "chat:1")).toBe("claude");
  });

  it("second message after fallback starts from the promoted CLI instead of retrying the exhausted one", async () => {
    setUserCliPreference(db, "chat:1", "codex");
    codex.handleUpdate = async () => {
      codex.handleCount++;
      exhaustedChats.add("chat:1");
    };

    // First message: codex exhausted → falls back to claude
    await dispatchInteractiveWithFallback({ update_id: 1, message: { text: "hello", chat: { id: 1 } } } as any, "chat:1", deps());
    expect(codex.handleCount).toBe(1);
    expect(claude.handleCount).toBe(1);

    // Codex stays available, but the promoted preference should start with claude.
    codex.handleUpdate = async () => { codex.handleCount++; };

    await dispatchInteractiveWithFallback({ update_id: 2, message: { text: "next", chat: { id: 1 } } } as any, "chat:1", deps());
    expect(codex.handleCount).toBe(1);
    expect(claude.handleCount).toBe(2);
  });

  it("clears the target CLI's stale session and marks handoff required on fallback", async () => {
    setUserCliPreference(db, "chat:1", "codex");
    db.setSession("chat:1", "claude", "stale-claude-session-from-weeks-ago");
    codex.handleUpdate = async () => {
      codex.handleCount++;
      exhaustedChats.add("chat:1");
    };

    await dispatchInteractiveWithFallback({ update_id: 1, message: { text: "hello", chat: { id: 1 } } } as any, "chat:1", deps());

    expect(db.getSession("chat:1", "claude")).toBeNull();
    expect(isHandoffRequired(db, "chat:1", "claude")).toBe(true);
  });

  it("passes outgoing, incoming, and exhausted CLIs to fallback compaction", async () => {
    setUserCliPreference(db, "chat:1", "codex");
    codex.handleUpdate = async () => {
      codex.handleCount++;
      exhaustedChats.add("chat:1");
    };
    const compactCalls: Array<{
      chatKey: string;
      fromCli: string;
      toCli: string;
      exhaustedClis: readonly string[];
    }> = [];

    await dispatchInteractiveWithFallback(
      { update_id: 1, message: { text: "hello", chat: { id: 1 } } } as any,
      "chat:1",
      { ...deps(), compactBeforeSwitch: async (request) => {
        compactCalls.push(request);
        return { outcome: "no_turns", trigger: "capacity_fallback" };
      } },
    );

    expect(compactCalls).toEqual([{
      chatKey: "chat:1",
      fromCli: "codex",
      toCli: "claude",
      exhaustedClis: ["codex"],
    }]);
  });

  it("does not block fallback when compactBeforeSwitch rejects", async () => {
    setUserCliPreference(db, "chat:1", "codex");
    codex.handleUpdate = async () => {
      codex.handleCount++;
      exhaustedChats.add("chat:1");
    };

    await dispatchInteractiveWithFallback(
      { update_id: 1, message: { text: "hello", chat: { id: 1 } } } as any,
      "chat:1",
      { ...deps(), compactBeforeSwitch: async () => { throw new Error("CLI down, cannot compact"); } },
    );

    expect(claude.handleCount).toBe(1);
    expect(getUserCliPreference(db, "chat:1")).toBe("claude");
  });

  it("does not block fallback or set success cooldown when compaction returns failed", async () => {
    setUserCliPreference(db, "chat:1", "codex");
    codex.handleUpdate = async () => { exhaustedChats.add("chat:1"); };
    const compactBeforeSwitch = vi.fn().mockResolvedValue({
      outcome: "failed", trigger: "capacity_fallback", error: "invalid compact JSON output",
    });

    await dispatchInteractiveWithFallback(
      { update_id: 1, message: { text: "hello", chat: { id: 1 } } } as any,
      "chat:1",
      { ...deps(), compactBeforeSwitch },
    );

    expect(claude.handleCount).toBe(1);
    expect(db.getSetting("fallback_compact_last_success_at:chat:1")).toBeNull();

    setUserCliPreference(db, "chat:1", "codex");
    await dispatchInteractiveWithFallback(
      { update_id: 2, message: { text: "again", chat: { id: 1 } } } as any,
      "chat:1",
      { ...deps(), compactBeforeSwitch },
    );
    expect(compactBeforeSwitch).toHaveBeenCalledTimes(2);
  });

  it("sets success cooldown only when fallback compaction succeeds", async () => {
    setUserCliPreference(db, "chat:1", "codex");
    codex.handleUpdate = async () => { exhaustedChats.add("chat:1"); };
    const compactBeforeSwitch = vi.fn().mockResolvedValue({
      outcome: "compacted", trigger: "capacity_fallback", summaryMd: "done",
    });

    await dispatchInteractiveWithFallback(
      { update_id: 1, message: { text: "hello", chat: { id: 1 } } } as any,
      "chat:1",
      { ...deps(), compactBeforeSwitch },
    );

    expect(db.getSetting("fallback_compact_last_success_at:chat:1")).toBeTruthy();
  });

  it("skips compactBeforeSwitch on a second fallback within the cooldown window", async () => {
    setUserCliPreference(db, "chat:1", "codex");
    let attempts = 0;

    // First fallback: codex -> claude
    codex.handleUpdate = async () => { exhaustedChats.add("chat:1"); };
    await dispatchInteractiveWithFallback(
      { update_id: 1, message: { text: "hello", chat: { id: 1 } } } as any,
      "chat:1",
      { ...deps(), compactBeforeSwitch: async () => { attempts++; return { outcome: "compacted", trigger: "capacity_fallback" }; } },
    );
    expect(attempts).toBe(1);

    // Second fallback happens immediately after (claude -> antigravity): cooldown should skip the compact call.
    claude.handleUpdate = async () => { exhaustedChats.add("chat:1"); };
    await dispatchInteractiveWithFallback(
      { update_id: 2, message: { text: "again", chat: { id: 1 } } } as any,
      "chat:1",
      { ...deps(), compactBeforeSwitch: async () => { attempts++; return { outcome: "compacted", trigger: "capacity_fallback" }; } },
    );
    expect(attempts).toBe(1);
  });
});

describe("applyManualCliSwitchHandoff", () => {
  let db: BridgeDb;

  beforeEach(() => {
    db = openDb(":memory:");
  });

  it("clears the target CLI's session so it starts fresh", () => {
    db.setSession("chat:1", "claude", "old-session-id");
    applyManualCliSwitchHandoff(db, "chat:1", "claude");
    expect(db.getSession("chat:1", "claude")).toBeNull();
  });

  it("marks handoff required for the target CLI", () => {
    applyManualCliSwitchHandoff(db, "chat:1", "claude");
    expect(isHandoffRequired(db, "chat:1", "claude")).toBe(true);
  });

  it("does not affect a different chat or a different CLI's session/handoff state", () => {
    db.setSession("chat:1", "codex", "keep-me");
    applyManualCliSwitchHandoff(db, "chat:1", "claude");
    expect(db.getSession("chat:1", "codex")).toBe("keep-me");
    expect(isHandoffRequired(db, "chat:1", "codex")).toBe(false);
    expect(isHandoffRequired(db, "chat:2", "claude")).toBe(false);
  });
});
