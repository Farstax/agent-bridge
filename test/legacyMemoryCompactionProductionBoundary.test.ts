import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { openDb } from "../src/db.js";
import { BridgeEngine } from "../src/engine.js";
import { ProviderFallbackChain } from "../src/providerFallback.js";
import {
  applyManualCliSwitchHandoff,
  dispatchClaimedInteractiveWithFallback,
  dispatchInteractiveWithFallback,
  getUserCliPreference,
  setUserCliPreference,
  type CliKind,
} from "../src/interactiveBot.js";
import type { BridgeConfig, TelegramMessage, TelegramUpdate } from "../src/types.js";

const FLAG = "BRIDGE_LEGACY_MEMORY_COMPACTION_ENABLED";
const CHAT_KEY = "100";
const EXACT_OLD_TURN = "exact retained decision: use the falcon rollout";
const EXACT_RECENT_TURN = "exact retained follow-up: falcon remains current";
const STALE_SUMMARY = "STALE GENERATED SUMMARY MUST NOT BE SEEDED";
const LEGACY_MEMORY = "legacy project memory must stay hidden by default";

beforeEach(() => {
  delete process.env[FLAG];
});

function makeMockClient() {
  return {
    getUpdates: vi.fn().mockResolvedValue({ result: [], ok: true }),
    sendMessage: vi.fn().mockResolvedValue({ ok: true, result: { message_id: 1 } }),
    sendChatAction: vi.fn().mockResolvedValue({ ok: true }),
    setMyCommands: vi.fn().mockResolvedValue({ ok: true }),
    answerCallbackQuery: vi.fn().mockResolvedValue({ ok: true }),
    editMessageText: vi.fn().mockResolvedValue({ ok: true }),
    deleteMessage: vi.fn().mockResolvedValue({ ok: true }),
    sendPhoto: vi.fn().mockResolvedValue({ ok: true }),
    sendDocument: vi.fn().mockResolvedValue({ ok: true }),
  } as any;
}

function makeMessage(text: string, messageId = 1): TelegramMessage {
  return {
    message_id: messageId,
    chat: { id: 100, type: "private" },
    from: { id: 42, first_name: "Test" },
    text,
  };
}

function makeUpdate(text: string, updateId: number, messageId: number): TelegramUpdate {
  return { update_id: updateId, message: makeMessage(text, messageId) };
}

function makeConfig(dbPath: string): BridgeConfig {
  return {
    allowedUserIds: new Set(["42"]),
    serviceEnvFile: null,
    serviceKind: null,
    pollIntervalMs: 1000,
    executionMode: "safe",
    asyncEnabled: false,
    dbPath,
    bots: {
      codex: { token: undefined, command: "codex", modelPreference: [] },
      claude: { token: undefined, command: "claude", modelPreference: [] },
      antigravity: { token: undefined, command: "agy", modelPreference: [] },
    },
  };
}

function seedLegacyAndExactHistory(db: ReturnType<typeof openDb>): void {
  db.addConvTurn(CHAT_KEY, "user", EXACT_OLD_TURN, "codex");
  db.addConvSummary(CHAT_KEY, 1, 1, STALE_SUMMARY);
  db.addConvTurn(CHAT_KEY, "assistant", EXACT_RECENT_TURN, "codex");
  db.addMemory({ id: "legacy-boundary-memory", type: "decision", scope: "project", text: LEGACY_MEMORY });
}

function makeEngine(
  kind: CliKind,
  db: ReturnType<typeof openDb>,
  dbPath: string,
  client: ReturnType<typeof makeMockClient>,
  runCli: (...args: any[]) => Promise<any>,
  exhaustedChats?: Set<string>,
): BridgeEngine {
  return new BridgeEngine(
    {
      surfaceIdentity: "telegram:interactive",
      kind,
      botConfig: { command: kind === "antigravity" ? "agy" : kind, modelPreference: [] },
      allowedUserIds: new Set(["42"]),
      executionMode: "safe",
      busyMessageMode: "augment",
      asyncEnabled: false,
      pollIntervalMs: 1000,
      fullConfig: makeConfig(dbPath),
      hooks: exhaustedChats ? {
        onCapacityExhausted: async (chatKey: string) => { exhaustedChats.add(chatKey); },
      } : undefined,
    },
    db,
    client,
    { runCli: runCli as any },
  );
}

afterEach(() => {
  process.env[FLAG] = "true";
  delete process.env.BRIDGE_CONTEXT_MAX_CHARS;
  vi.restoreAllMocks();
});

describe("turn-history default production handoff boundaries", () => {
  it("manual switch starts fresh with exact retained turns, excludes legacy summary/memory, then resumes without reseeding", async () => {
    const dbPath = join(tmpdir(), `legacy-manual-boundary-${Date.now()}-${Math.random()}.sqlite`);
    const db = openDb(dbPath);
    const client = makeMockClient();
    const prompts: string[] = [];
    const runCli = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
      prompts.push(args[args.length - 1]);
      return JSON.stringify({ type: "result", result: "ok", session_id: "claude-fresh-after-manual-switch" });
    });

    try {
      seedLegacyAndExactHistory(db);
      db.setSession(CHAT_KEY, "claude", "stale-claude-session");
      setUserCliPreference(db, CHAT_KEY, "codex");

      applyManualCliSwitchHandoff(db, CHAT_KEY, "claude");
      expect(db.getSession(CHAT_KEY, "claude")).toBeNull();

      const claude = makeEngine("claude", db, dbPath, client, runCli);
      await claude.handleMessages([makeMessage("continue after manual switch", 10)]);

      expect(prompts[0]).toContain(EXACT_OLD_TURN);
      expect(prompts[0]).toContain(EXACT_RECENT_TURN);
      expect(prompts[0]).not.toContain(STALE_SUMMARY);
      expect(prompts[0]).not.toContain(LEGACY_MEMORY);
      expect(prompts[0]).not.toContain("--memory-query");
      expect(prompts[0]).toContain("AGENT_BRIDGE_CONTEXT_COMMAND");
      expect(db.getSession(CHAT_KEY, "claude")).toBe("claude-fresh-after-manual-switch");

      await claude.handleMessages([makeMessage("same provider continuation", 11)]);

      expect(prompts[1]).toContain("same provider continuation");
      expect(prompts[1]).not.toContain(EXACT_OLD_TURN);
      expect(prompts[1]).not.toContain(EXACT_RECENT_TURN);
      expect(prompts[1]).not.toContain(STALE_SUMMARY);
      expect(prompts[1]).not.toContain(LEGACY_MEMORY);
      expect(prompts[1]).not.toContain("[Context from previous conversation]");
    } finally {
      db.close();
      rmSync(dbPath, { force: true });
    }
  });

  it("capacity fallback skips compaction entirely, gives the fresh successor exact turns, and does not reseed its resumed session", async () => {
    const dbPath = join(tmpdir(), `legacy-fallback-boundary-${Date.now()}-${Math.random()}.sqlite`);
    const db = openDb(dbPath);
    const client = makeMockClient();
    const exhaustedChats = new Set<string>();
    const fallbackChain = new ProviderFallbackChain(["codex", "claude"], db);
    const claudePrompts: string[] = [];
    const codexRun = vi.fn().mockRejectedValue(new Error("rate limit capacity exhausted"));
    const claudeRun = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
      claudePrompts.push(args[args.length - 1]);
      return JSON.stringify({ type: "result", result: "fallback complete", session_id: "claude-fallback-session" });
    });
    const compactBeforeSwitch = vi.fn(async () => ({
      outcome: "failed" as const,
      trigger: "capacity_fallback" as const,
      error: "must not be invoked while legacy mode is disabled",
    }));
    const notifications: string[] = [];

    try {
      seedLegacyAndExactHistory(db);
      setUserCliPreference(db, CHAT_KEY, "codex");

      const engines = {
        codex: makeEngine("codex", db, dbPath, client, codexRun, exhaustedChats),
        claude: makeEngine("claude", db, dbPath, client, claudeRun, exhaustedChats),
      };
      const deps = {
        engines,
        fallbackChain,
        exhaustedChats,
        db,
        notify: async (message: string) => { notifications.push(message); },
        compactBeforeSwitch,
      };
      for (const engine of Object.values(engines)) {
        engine.setQueuedMessageHandler(async (queued) =>
          dispatchClaimedInteractiveWithFallback(queued, queued.chatKey, deps));
      }

      await dispatchInteractiveWithFallback(
        makeUpdate("fallback request", 100, 20),
        CHAT_KEY,
        deps,
      );

      expect(codexRun).toHaveBeenCalledTimes(1);
      expect(claudeRun).toHaveBeenCalledTimes(1);
      expect(compactBeforeSwitch).not.toHaveBeenCalled();
      expect(notifications).toEqual(["Switching to claude (codex at capacity)"]);
      expect(claudePrompts[0]).toContain(EXACT_OLD_TURN);
      expect(claudePrompts[0]).toContain(EXACT_RECENT_TURN);
      expect(claudePrompts[0]).not.toContain(STALE_SUMMARY);
      expect(claudePrompts[0]).not.toContain(LEGACY_MEMORY);
      expect(claudePrompts[0]).not.toContain("--memory-query");
      expect(claudePrompts[0]).toContain("AGENT_BRIDGE_CONTEXT_COMMAND");
      expect(getUserCliPreference(db, CHAT_KEY)).toBe("claude");
      expect(db.getSession(CHAT_KEY, "claude")).toBe("claude-fallback-session");

      await dispatchInteractiveWithFallback(
        makeUpdate("continue on claude", 101, 21),
        CHAT_KEY,
        deps,
      );

      expect(codexRun).toHaveBeenCalledTimes(1);
      expect(claudeRun).toHaveBeenCalledTimes(2);
      expect(compactBeforeSwitch).not.toHaveBeenCalled();
      expect(claudePrompts[1]).toContain("continue on claude");
      expect(claudePrompts[1]).not.toContain(EXACT_OLD_TURN);
      expect(claudePrompts[1]).not.toContain(EXACT_RECENT_TURN);
      expect(claudePrompts[1]).not.toContain(STALE_SUMMARY);
      expect(claudePrompts[1]).not.toContain(LEGACY_MEMORY);
      expect(claudePrompts[1]).not.toContain("[Context from previous conversation]");
    } finally {
      db.close();
      rmSync(dbPath, { force: true });
    }
  });

  it("explicit rollback-on restores legacy summary-first and project-memory handoff hints", async () => {
    process.env[FLAG] = "true";
    const dbPath = join(tmpdir(), `legacy-rollback-boundary-${Date.now()}-${Math.random()}.sqlite`);
    const db = openDb(dbPath);
    const client = makeMockClient();
    const prompts: string[] = [];
    const runCli = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
      prompts.push(args[args.length - 1]);
      return JSON.stringify({ type: "result", result: "rollback ok", session_id: "claude-rollback-session" });
    });

    try {
      seedLegacyAndExactHistory(db);
      setUserCliPreference(db, CHAT_KEY, "codex");
      applyManualCliSwitchHandoff(db, CHAT_KEY, "claude");

      const claude = makeEngine("claude", db, dbPath, client, runCli);
      await claude.handleMessages([makeMessage("continue with rollback enabled", 30)]);

      expect(prompts[0]).toContain(STALE_SUMMARY);
      expect(prompts[0]).not.toContain(EXACT_OLD_TURN);
      expect(prompts[0]).toContain(EXACT_RECENT_TURN);
      expect(prompts[0]).toContain("--memory-query");
      expect(db.getMemoryCount()).toBe(1);
      expect(db.getSession(CHAT_KEY, "claude")).toBe("claude-rollback-session");
    } finally {
      db.close();
      rmSync(dbPath, { force: true });
    }
  });
});
