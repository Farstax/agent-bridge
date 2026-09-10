import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { openDb } from "../src/db.js";
import type { BridgeDb } from "../src/db.js";
import type { TelegramMessage } from "../src/types.js";

// runProviderInvocation is the provider-neutral ACP transport entry point used
// by engine.ts. Mocking it here lets these tests drive the
// engine's real cancellation/delivery/persistence pipeline deterministically,
// without spawning a real ACP stdio child — except for the explicit
// production-shaped lease-loss regression, which delegates through the actual
// generic implementation before invalidating the Bridge lane.
const runProviderInvocationMock = vi.fn();
vi.mock("../src/cli.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/cli.js")>();
  return { ...actual, runProviderInvocation: runProviderInvocationMock };
});

const fakeAgent = fileURLToPath(new URL("./support/fakeAcpAgent.ts", import.meta.url));

function makeMessage(text: string, userId = 42, chatId = 100): TelegramMessage {
  return {
    message_id: Math.floor(Math.random() * 10000),
    chat: { id: chatId, type: "private" },
    from: { id: userId, first_name: "Test" },
    text,
  };
}

function makeMockClient() {
  return {
    capabilities: {
      maxMessageLength: 4096,
      editMessages: true,
      deleteMessages: true,
      previewStreaming: true,
      threads: true,
      attachments: true,
      typing: true,
      polling: true,
      remoteFileDownload: true,
      richMessages: true,
      passiveSurroundingContext: false,
      formatting: "telegram-html",
    },
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

describe("ACP provider-cancellation terminal lifecycle", () => {
  let dbPath: string;
  let db: BridgeDb;

  beforeEach(() => {
    dbPath = join(tmpdir(), `acp-cancel-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    db = openDb(dbPath);
    process.env.CODEX_ACP_COMMAND = "codex-acp";
    runProviderInvocationMock.mockReset();
  });

  afterEach(() => {
    db.close();
    try { rmSync(dbPath); } catch {}
    delete process.env.CODEX_ACP_COMMAND;
    delete process.env.CODEX_ACP_ARGS;
    delete process.env.FAKE_ACP_OUTPUT_FILE;
  });

  it("does not deliver, complete, or remember a turn the provider ended with stopReason=cancelled", async () => {
    runProviderInvocationMock.mockImplementation(async (
      _bot: unknown,
      _invocation: unknown,
      _cwd: string,
      options: { onAnswerDelta?: (text: string) => void },
    ) => {
      options.onAnswerDelta?.("provisional, must not survive");
      return {
        text: "",
        sessionId: "acp-session-cancelled-1",
        stopReason: "cancelled",
      };
    });
    const { BridgeEngine } = await import("../src/engine.js");
    const client = makeMockClient();
    const engine = new BridgeEngine(
      { surfaceIdentity: "test", kind: "codex", botConfig: { command: "codex", modelPreference: [] }, allowedUserIds: new Set(["42"]), executionMode: "safe", pollIntervalMs: 1000 },
      db, client, {},
    );

    await engine.handleMessages([makeMessage("hello")]);
    await new Promise<void>((resolve) => setImmediate(resolve));

    // No normal final-answer delivery to the surface.
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    expect(client.deleteMessage).toHaveBeenCalledWith({ chat_id: 100, message_id: 1 });

    // The ACP session is preserved so a later turn can resume it...
    expect(db.getAcpSessionBinding("100", "codex")?.acpSessionId).toBe("acp-session-cancelled-1");
    // ...but nothing was remembered as a completed conversation turn.
    expect(db.getConvStatus("100", "test").turnCount).toBe(0);

    // The durable Run row is cancelled, never completed.
    const runs = db.raw.prepare("SELECT status FROM bridge_runs WHERE chat_id = ?").all("100") as Array<{ status: string }>;
    expect(runs.length).toBeGreaterThan(0);
    for (const run of runs) expect(run.status).toBe("cancelled");
  });

  it("removes generated output from a provider-cancelled turn without publishing attachments", async () => {
    let cancelledOutputDir: string | null = null;
    runProviderInvocationMock.mockImplementation(async (
      _bot: unknown,
      _invocation: unknown,
      _cwd: string,
      _options: unknown,
      request: { outputDir?: string | null },
    ) => {
      cancelledOutputDir = request.outputDir ?? null;
      if (!cancelledOutputDir) throw new Error("missing ACP outputDir in cancellation test");
      writeFileSync(join(cancelledOutputDir, "partial.txt"), "partial output from cancelled turn");
      return {
        text: "",
        sessionId: "acp-session-cancelled-output-1",
        stopReason: "cancelled",
      };
    });
    const { BridgeEngine } = await import("../src/engine.js");
    const client = makeMockClient();
    const engine = new BridgeEngine(
      { surfaceIdentity: "test", kind: "codex", botConfig: { command: "codex", modelPreference: [] }, allowedUserIds: new Set(["42"]), executionMode: "safe", pollIntervalMs: 1000 },
      db, client, {},
    );

    await engine.handleMessages([makeMessage("hello")]);

    expect(cancelledOutputDir).not.toBeNull();
    expect(existsSync(cancelledOutputDir!)).toBe(false);
    expect(client.sendPhoto).not.toHaveBeenCalled();
    expect(client.sendDocument).not.toHaveBeenCalled();
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  it("cleans cancelled output before a post-provider lease loss can fence settlement", async () => {
    const actualCli = await vi.importActual<typeof import("../src/cli.js")>("../src/cli.js");
    process.env.CODEX_ACP_COMMAND = process.execPath;
    process.env.CODEX_ACP_ARGS = `${join(process.cwd(), "node_modules/tsx/dist/cli.mjs")} ${fakeAgent}`;

    let fencedOutputDir: string | null = null;
    runProviderInvocationMock.mockImplementation(async (...args: Parameters<typeof actualCli.runProviderInvocation>) => {
      const request = args[4];
      fencedOutputDir = request.outputDir ?? null;
      if (!fencedOutputDir) throw new Error("missing ACP outputDir in fenced cancellation test");
      process.env.FAKE_ACP_OUTPUT_FILE = join(fencedOutputDir, "partial.txt");
      const result = await actualCli.runProviderInvocation(...args);
      // Simulate authority disappearing in the narrow window after the ACP
      // turn has settled but before BridgeEngine's first post-provider fence.
      db.raw.prepare("DELETE FROM execution_locks WHERE surface = ? AND chat_key = ?").run("test", "100");
      return result;
    });

    const { BridgeEngine } = await import("../src/engine.js");
    const client = makeMockClient();
    const engine = new BridgeEngine(
      { surfaceIdentity: "test", kind: "codex", botConfig: { command: "codex", modelPreference: [] }, allowedUserIds: new Set(["42"]), executionMode: "safe", pollIntervalMs: 1000 },
      db, client, {},
    );

    await engine.handleMessages([makeMessage("CANCEL_WITH_OUTPUT")]);

    expect(fencedOutputDir).not.toBeNull();
    expect(existsSync(fencedOutputDir!)).toBe(false);
    expect(client.sendPhoto).not.toHaveBeenCalled();
    expect(client.sendDocument).not.toHaveBeenCalled();
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(db.getConvStatus("100", "test").turnCount).toBe(0);
    const runs = db.raw.prepare("SELECT status FROM bridge_runs WHERE chat_id = ?").all("100") as Array<{ status: string }>;
    expect(runs.length).toBeGreaterThan(0);
    for (const run of runs) expect(run.status).toBe("cancelled");
  });

  it("still delivers, completes, and remembers a normal (non-cancelled) ACP turn", async () => {
    runProviderInvocationMock.mockImplementation(async (
      _bot: unknown,
      _invocation: unknown,
      _cwd: string,
      options: { onAnswerDelta?: (text: string) => void },
    ) => {
      options.onAnswerDelta?.("the provisional ");
      options.onAnswerDelta?.("answer");
      return {
        text: "the real answer",
        sessionId: "acp-session-normal-1",
        stopReason: "end_turn",
      };
    });
    const { BridgeEngine } = await import("../src/engine.js");
    const client = makeMockClient();
    const engine = new BridgeEngine(
      { surfaceIdentity: "test", kind: "codex", botConfig: { command: "codex", modelPreference: [] }, allowedUserIds: new Set(["42"]), executionMode: "safe", pollIntervalMs: 1000 },
      db, client, {},
    );

    await engine.handleMessages([makeMessage("hello")]);

    expect(typeof runProviderInvocationMock.mock.calls[0][3].onAnswerDelta).toBe("function");
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    expect(client.editMessageText).toHaveBeenCalledWith(expect.objectContaining({
      message_id: 1,
      text: expect.stringContaining("the real answer"),
    }));
    expect(db.getAcpSessionBinding("100", "codex")?.acpSessionId).toBe("acp-session-normal-1");
    expect(db.getConvStatus("100", "test").turnCount).toBeGreaterThan(0);
    const turns = db.raw.prepare(
      "SELECT role, text FROM conversation_turns WHERE chat_key = ? ORDER BY id ASC",
    ).all("100") as Array<{ role: string; text: string }>;
    expect(turns.at(-1)).toMatchObject({ role: "assistant", text: "the real answer" });
    const runs = db.raw.prepare(
      "SELECT status, final_text_preview FROM bridge_runs WHERE chat_id = ?",
    ).all("100") as Array<{ status: string; final_text_preview: string }>;
    expect(runs.length).toBeGreaterThan(0);
    for (const run of runs) {
      expect(run.status).toBe("done");
      expect(run.final_text_preview).toBe("the real answer");
    }
  });

  it("permits a later turn in the same conversation to proceed normally after provider cancellation", async () => {
    runProviderInvocationMock.mockResolvedValueOnce({
      text: "",
      sessionId: "acp-session-recover-1",
      stopReason: "cancelled",
    });
    runProviderInvocationMock.mockResolvedValueOnce({
      text: "resumed answer",
      sessionId: "acp-session-recover-1",
      stopReason: "end_turn",
    });
    const { BridgeEngine } = await import("../src/engine.js");
    const client = makeMockClient();
    const engine = new BridgeEngine(
      { surfaceIdentity: "test", kind: "codex", botConfig: { command: "codex", modelPreference: [] }, allowedUserIds: new Set(["42"]), executionMode: "safe", pollIntervalMs: 1000 },
      db, client, {},
    );

    await engine.handleMessages([makeMessage("first")]);
    await engine.handleMessages([makeMessage("second")]);

    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    expect(client.sendMessage.mock.calls[0][0].text).toContain("resumed answer");
    expect(runProviderInvocationMock).toHaveBeenCalledTimes(2);
    expect(runProviderInvocationMock.mock.calls[1][4].sessionId).toBe("acp-session-recover-1");
  });

  it("passes the transient answer callback to a Codex ACP model fallback attempt", async () => {
    runProviderInvocationMock.mockRejectedValueOnce(new Error("MODEL_CAPACITY_EXHAUSTED"));
    runProviderInvocationMock.mockImplementationOnce(async (
      _bot: unknown,
      _invocation: unknown,
      _cwd: string,
      options: { onAnswerDelta?: (text: string) => void },
    ) => {
      options.onAnswerDelta?.("fallback preview");
      return {
        text: "fallback answer",
        sessionId: "acp-session-fallback-1",
        stopReason: "end_turn",
      };
    });
    const { BridgeEngine } = await import("../src/engine.js");
    const client = makeMockClient();
    const engine = new BridgeEngine(
      {
        surfaceIdentity: "test",
        kind: "codex",
        botConfig: { command: "codex", modelPreference: ["primary", "fallback"] },
        allowedUserIds: new Set(["42"]),
        executionMode: "safe",
        pollIntervalMs: 1000,
      },
      db,
      client,
      {},
    );

    await engine.handleMessages([makeMessage("hello")]);

    expect(runProviderInvocationMock).toHaveBeenCalledTimes(2);
    expect(typeof runProviderInvocationMock.mock.calls[1][3].onAnswerDelta).toBe("function");
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    expect(client.editMessageText).toHaveBeenCalledWith(expect.objectContaining({
      message_id: 1,
      text: expect.stringContaining("fallback answer"),
    }));
  });

  it("does not turn a cancelled turn into an error reply or a completion when the ACP session binding write fails for a non-fencing reason", async () => {
    // putAcpSessionBinding refuses a session id equal to the Bridge
    // conversation id (chatKey "100" here) — a real, non-fencing DB
    // rejection, distinct from a lost execution lease.
    runProviderInvocationMock.mockResolvedValue({
      text: "",
      sessionId: "100",
      stopReason: "cancelled",
    });
    const { BridgeEngine } = await import("../src/engine.js");
    const client = makeMockClient();
    const engine = new BridgeEngine(
      { surfaceIdentity: "test", kind: "codex", botConfig: { command: "codex", modelPreference: [] }, allowedUserIds: new Set(["42"]), executionMode: "safe", pollIntervalMs: 1000 },
      db, client, {},
    );

    await engine.handleMessages([makeMessage("hello")]);

    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(db.getConvStatus("100", "test").turnCount).toBe(0);
    const runs = db.raw.prepare("SELECT status FROM bridge_runs WHERE chat_id = ?").all("100") as Array<{ status: string }>;
    expect(runs.length).toBeGreaterThan(0);
    for (const run of runs) expect(run.status).toBe("cancelled");
  });
});
