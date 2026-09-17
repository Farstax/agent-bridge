import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.js";
import { BridgeEngine } from "../src/engine.js";
import { lookupProviderSession } from "../src/providers/sessionRuntime.js";
import type { BridgeEvent } from "../src/events/types.js";
import type { TelegramMessage } from "../src/types.js";

const fakeAgent = fileURLToPath(new URL("./support/fakeSecondAcpAgent.ts", import.meta.url));
const tsxCli = join(process.cwd(), "node_modules/tsx/dist/cli.mjs");

function customEnv(args: string[] = [tsxCli, fakeAgent], extra: Record<string, string> = {}): Record<string, string> {
  return {
    CUSTOM_ACP_COMMAND: process.execPath,
    CUSTOM_ACP_ARGS_JSON: JSON.stringify(args),
    CUSTOM_ACP_AUTH_METHOD_ID: "workspace-token",
    ...extra,
  };
}

function makeMessage(text: string, chatId = 100, messageId = 1): TelegramMessage {
  return {
    message_id: messageId,
    chat: { id: chatId, type: "private" },
    from: { id: 42, first_name: "TestUser" },
    text,
  };
}

describe("custom ACP BridgeEngine lifecycle", () => {
  let dbPath: string;
  let db: ReturnType<typeof openDb>;
  let origEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    origEnv = { ...process.env };
    dbPath = join(tmpdir(), `custom-acp-engine-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    db = openDb(dbPath);
  });

  afterEach(() => {
    process.env = origEnv;
    db.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      try { rmSync(`${dbPath}${suffix}`); } catch {}
    }
  });

  it("executes custom ACP through BridgeEngine, persists session under runtime identity, and resumes after restart", async () => {
    Object.assign(process.env, customEnv());

    const sentMessages: string[] = [];
    const client = {
      sendMessage: vi.fn().mockImplementation(async (payload: { text: string }) => {
        sentMessages.push(payload.text);
        return { ok: true, result: { message_id: sentMessages.length } };
      }),
      sendChatAction: vi.fn().mockResolvedValue({ ok: true }),
    } as any;

    const collectedEvents: BridgeEvent[] = [];
    const engine1 = new BridgeEngine(
      {
        surfaceIdentity: "test-surface",
        kind: "custom-acp",
        botConfig: { command: "", modelPreference: [] },
        allowedUserIds: new Set(["42"]),
        executionMode: "safe",
        pollIntervalMs: 1000,
        workingDir: process.cwd(),
      },
      db,
      client,
    );

    // 1. First turn: execute prompt through BridgeEngine
    await engine1.handleMessages([makeMessage("hello custom ACP", 100, 1)]);
    expect(sentMessages[0]).toContain("fixture parent answer");

    // 2. Session persistence: inspect session in db
    const savedSession = lookupProviderSession(db, "100", "custom-acp");
    expect(savedSession).toBe("fixture-root-session");

    // 3. Restart/reload simulation: construct fresh BridgeEngine with same runtime launch config
    const client2 = {
      sendMessage: vi.fn().mockImplementation(async (payload: { text: string }) => {
        sentMessages.push(payload.text);
        return { ok: true, result: { message_id: sentMessages.length } };
      }),
      sendChatAction: vi.fn().mockResolvedValue({ ok: true }),
    } as any;

    const engine2 = new BridgeEngine(
      {
        surfaceIdentity: "test-surface",
        kind: "custom-acp",
        botConfig: { command: "", modelPreference: [] },
        allowedUserIds: new Set(["42"]),
        executionMode: "safe",
        pollIntervalMs: 1000,
        workingDir: process.cwd(),
      },
      db,
      client2,
    );

    // 4. Second turn: same runtime resumes existing session
    await engine2.handleMessages([makeMessage("second turn", 100, 2)]);
    expect(sentMessages[1]).toBe("fixture resumed answer:fixture-root-session");

    // 5. Changed runtime identity starts fresh and isolates session
    Object.assign(process.env, customEnv([tsxCli, fakeAgent, "--changed-flag"]));
    const client3 = {
      sendMessage: vi.fn().mockImplementation(async (payload: { text: string }) => {
        sentMessages.push(payload.text);
        return { ok: true, result: { message_id: sentMessages.length } };
      }),
      sendChatAction: vi.fn().mockResolvedValue({ ok: true }),
    } as any;

    const engine3 = new BridgeEngine(
      {
        surfaceIdentity: "test-surface",
        kind: "custom-acp",
        botConfig: { command: "", modelPreference: [] },
        allowedUserIds: new Set(["42"]),
        executionMode: "safe",
        pollIntervalMs: 1000,
        workingDir: process.cwd(),
      },
      db,
      client3,
    );

    await engine3.handleMessages([makeMessage("changed runtime turn", 100, 3)]);
    // New runtime starts fresh (produces fixture parent answer rather than resumed answer)
    expect(sentMessages[2]).toBe("fixture parent answer");
  }, 30_000);

  it("does not resume a custom ACP session after the effective workspace changes", async () => {
    const workspaceA = mkdtempSync(join(tmpdir(), "custom-acp-workspace-a-"));
    const workspaceB = mkdtempSync(join(tmpdir(), "custom-acp-workspace-b-"));
    try {
      Object.assign(process.env, customEnv([tsxCli, fakeAgent], {
        CUSTOM_ACP_PROJECT_DIR: workspaceA,
      }));

      const sentMessages: string[] = [];
      const client1 = {
        sendMessage: vi.fn().mockImplementation(async (payload: { text: string }) => {
          sentMessages.push(payload.text);
          return { ok: true, result: { message_id: sentMessages.length } };
        }),
        sendChatAction: vi.fn().mockResolvedValue({ ok: true }),
      } as any;

      const engine1 = new BridgeEngine(
        {
          surfaceIdentity: "test-surface",
          kind: "custom-acp",
          botConfig: { command: "", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000,
        },
        db,
        client1,
      );

      await engine1.handleMessages([makeMessage("workspace A turn", 106, 1)]);
      expect(sentMessages[0]).toBe("fixture parent answer");
      expect(lookupProviderSession(db, "106", "custom-acp")).toBe("fixture-root-session");

      Object.assign(process.env, customEnv([tsxCli, fakeAgent], {
        CUSTOM_ACP_PROJECT_DIR: workspaceB,
      }));

      const client2 = {
        sendMessage: vi.fn().mockImplementation(async (payload: { text: string }) => {
          sentMessages.push(payload.text);
          return { ok: true, result: { message_id: sentMessages.length } };
        }),
        sendChatAction: vi.fn().mockResolvedValue({ ok: true }),
      } as any;

      const engine2 = new BridgeEngine(
        {
          surfaceIdentity: "test-surface",
          kind: "custom-acp",
          botConfig: { command: "", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000,
        },
        db,
        client2,
      );

      await engine2.handleMessages([makeMessage("workspace B turn", 106, 2)]);
      expect(sentMessages[1]).toBe("fixture parent answer");
    } finally {
      rmSync(workspaceA, { recursive: true, force: true });
      rmSync(workspaceB, { recursive: true, force: true });
    }
  }, 30_000);

  it("records lifecycle events with bot identity custom-acp, not claude", async () => {
    Object.assign(process.env, customEnv());

    const client = {
      sendMessage: vi.fn().mockResolvedValue({ ok: true, result: { message_id: 1 } }),
      sendChatAction: vi.fn().mockResolvedValue({ ok: true }),
    } as any;

    const engine = new BridgeEngine(
      {
        surfaceIdentity: "test-surface",
        kind: "custom-acp",
        botConfig: { command: "", modelPreference: [] },
        allowedUserIds: new Set(["42"]),
        executionMode: "safe",
        pollIntervalMs: 1000,
        workingDir: process.cwd(),
      },
      db,
      client,
    );

    await engine.handleMessages([makeMessage("event check", 101, 1)]);

    // Check emitted events and runs in DB
    const runs = db.raw.prepare("SELECT * FROM bridge_runs WHERE chat_id = ?").all("101") as Array<{ run_id: string; bot: string; status: string }>;
    expect(runs.length).toBeGreaterThan(0);
    expect(runs[0]?.bot).toBe("custom-acp");

    const events = db.getEventsForRun(runs[0].run_id);
    const parsed = events.map((e) => JSON.parse(e.payload_json));
    const runStarted = parsed.find((e) => e.type === "run.started");
    expect(runStarted).toBeDefined();
    expect(runStarted?.bot).toBe("custom-acp");
  }, 30_000);

  it("handles provider cancellation through BridgeEngine", async () => {
    Object.assign(process.env, customEnv());

    const sentMessages: string[] = [];
    const client = {
      sendMessage: vi.fn().mockImplementation(async (payload: { text: string }) => {
        sentMessages.push(payload.text);
        return { ok: true, result: { message_id: sentMessages.length } };
      }),
      sendChatAction: vi.fn().mockResolvedValue({ ok: true }),
    } as any;

    const engine = new BridgeEngine(
      {
        surfaceIdentity: "test-surface",
        kind: "custom-acp",
        botConfig: { command: "", modelPreference: [] },
        allowedUserIds: new Set(["42"]),
        executionMode: "safe",
        pollIntervalMs: 1000,
        workingDir: process.cwd(),
      },
      db,
      client,
    );

    await engine.handleMessages([makeMessage("CANCEL this turn", 102, 1)]);
    // Cancelled turn should suppress normal answer delivery and record cancelled status
    expect(sentMessages).toHaveLength(0);
    const runs = db.raw.prepare("SELECT * FROM bridge_runs WHERE chat_id = ?").all("102") as Array<{ bot: string; status: string }>;
    expect(runs.length).toBeGreaterThan(0);
    expect(runs[0]?.status).toBe("cancelled");
    expect(runs[0]?.bot).toBe("custom-acp");
  }, 30_000);

  it("evaluates permission authority through shared ACP mapping in safe and trusted modes", async () => {
    Object.assign(process.env, customEnv());

    const sentSafe: string[] = [];
    const safeClient = {
      sendMessage: vi.fn().mockImplementation(async (payload: { text: string }) => {
        sentSafe.push(payload.text);
        return { ok: true, result: { message_id: sentSafe.length } };
      }),
      sendChatAction: vi.fn().mockResolvedValue({ ok: true }),
    } as any;

    const safeEngine = new BridgeEngine(
      {
        surfaceIdentity: "test-surface",
        kind: "custom-acp",
        botConfig: { command: "", modelPreference: [] },
        allowedUserIds: new Set(["42"]),
        executionMode: "safe",
        pollIntervalMs: 1000,
        workingDir: process.cwd(),
      },
      db,
      safeClient,
    );

    await safeEngine.handleMessages([makeMessage("PERMISSION_PROBE", 103, 1)]);
    expect(sentSafe[0]).toBe("permission decision:deny");

    const sentTrusted: string[] = [];
    const trustedClient = {
      sendMessage: vi.fn().mockImplementation(async (payload: { text: string }) => {
        sentTrusted.push(payload.text);
        return { ok: true, result: { message_id: sentTrusted.length } };
      }),
      sendChatAction: vi.fn().mockResolvedValue({ ok: true }),
    } as any;

    const trustedEngine = new BridgeEngine(
      {
        surfaceIdentity: "test-surface",
        kind: "custom-acp",
        botConfig: { command: "", modelPreference: [] },
        allowedUserIds: new Set(["42"]),
        executionMode: "trusted",
        pollIntervalMs: 1000,
        workingDir: process.cwd(),
      },
      db,
      trustedClient,
    );

    await trustedEngine.handleMessages([makeMessage("PERMISSION_PROBE", 104, 1)]);
    expect(sentTrusted[0]).toBe("permission decision:allow");
  }, 30_000);

  it("resets custom ACP session on /reset", async () => {
    Object.assign(process.env, customEnv());

    const client = {
      sendMessage: vi.fn().mockResolvedValue({ ok: true, result: { message_id: 1 } }),
      sendChatAction: vi.fn().mockResolvedValue({ ok: true }),
    } as any;

    const engine = new BridgeEngine(
      {
        surfaceIdentity: "test-surface",
        kind: "custom-acp",
        botConfig: { command: "", modelPreference: [] },
        allowedUserIds: new Set(["42"]),
        executionMode: "safe",
        pollIntervalMs: 1000,
        workingDir: process.cwd(),
      },
      db,
      client,
    );

    // Initial turn creates session
    await engine.handleMessages([makeMessage("initial", 105, 1)]);
    expect(lookupProviderSession(db, "105", "custom-acp")).toBe("fixture-root-session");

    // /reset clears session
    await engine.handleMessages([makeMessage("/reset", 105, 2)]);
    expect(lookupProviderSession(db, "105", "custom-acp")).toBeNull();
  }, 30_000);
});