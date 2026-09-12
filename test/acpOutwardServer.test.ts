import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as acp from "@agentclientprotocol/sdk";
import { openDb } from "../src/db.js";

const fakeAgent = fileURLToPath(new URL("./support/fakeAcpAgent.ts", import.meta.url));

type JsonRpcResponse = {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly result?: {
    readonly protocolVersion?: number;
    readonly agentCapabilities?: Record<string, unknown>;
    readonly agentInfo?: { readonly name?: string };
    readonly sessionId?: string;
    readonly stopReason?: string;
  };
  readonly error?: {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
  };
};

type JsonRpcNotification = {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: {
    readonly sessionId?: string;
    readonly update?: unknown;
  };
};

type JsonRpcMessage = JsonRpcResponse | JsonRpcNotification;

type RunningOutwardAcp = {
  child: ChildProcessWithoutNullStreams;
  output: Interface;
  lines: AsyncIterator<string>;
  stderr: () => string;
};

function providerEnv(providerStore: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    BRIDGE_PROVIDER_LOCK: "codex",
    INTERACTIVE_CLI_CHAIN: "codex",
    CODEX_ACP_COMMAND: process.execPath,
    CODEX_ACP_ARGS: `${join(process.cwd(), "node_modules/tsx/dist/cli.mjs")} ${fakeAgent}`,
    FAKE_ACP_STORE: providerStore,
    ...extra,
  };
}

function startOutwardAcpProcess(dbPath: string, extraEnv: NodeJS.ProcessEnv = {}): RunningOutwardAcp {
  const child = spawn(process.execPath, ["--import", "tsx", "src/acpServer/stdio.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DB_PATH: dbPath,
      NODE_ENV: "test",
      AGENT_BRIDGE_INSTALLATION_ID: "",
      ...extraEnv,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const output = createInterface({ input: child.stdout });
  return {
    child,
    output,
    lines: output[Symbol.asyncIterator](),
    stderr: () => stderr,
  };
}

function processExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function stopProcess(process: RunningOutwardAcp): Promise<void> {
  const { child, output } = process;
  if (!processExited(child)) {
    const gracefulExit = once(child, "exit");
    child.stdin.end();
    await Promise.race([gracefulExit, delay(1_000)]);
    if (!processExited(child)) {
      const terminated = once(child, "exit");
      child.kill("SIGTERM");
      await Promise.race([terminated, delay(1_000)]);
    }
    if (!processExited(child)) {
      const forcedExit = once(child, "exit");
      child.kill("SIGKILL");
      await forcedExit;
    }
  }
  output.close();
}

async function waitForExit(process: RunningOutwardAcp, timeoutMs = 3_000): Promise<void> {
  if (processExited(process.child)) return;
  await Promise.race([
    once(process.child, "exit").then(() => undefined),
    delay(timeoutMs).then(() => {
      throw new Error(`outward ACP process did not exit after disconnect; stderr=${process.stderr()}`);
    }),
  ]);
}

async function nextMessage(process: RunningOutwardAcp): Promise<JsonRpcMessage> {
  const next = await process.lines.next();
  if (next.done) {
    throw new Error(`outward ACP process closed stdout before responding; stderr=${process.stderr()}`);
  }
  return JSON.parse(next.value) as JsonRpcMessage;
}

async function nextResponse(process: RunningOutwardAcp): Promise<JsonRpcResponse> {
  const message = await nextMessage(process);
  if (!("id" in message)) {
    throw new Error(`outward ACP process sent notification before expected response: ${message.method}`);
  }
  return message;
}

async function readThroughResponse(
  process: RunningOutwardAcp,
  id: number,
): Promise<{ response: JsonRpcResponse; notifications: JsonRpcNotification[] }> {
  const notifications: JsonRpcNotification[] = [];
  for (;;) {
    const message = await nextMessage(process);
    if ("method" in message) {
      notifications.push(message);
      continue;
    }
    if (message.id !== id) {
      throw new Error(`outward ACP process returned unexpected response id ${message.id}; expected ${id}`);
    }
    return { response: message, notifications };
  }
}

async function initialize(process: RunningOutwardAcp, id: number): Promise<JsonRpcResponse> {
  process.child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    },
  })}\n`);
  return nextResponse(process);
}

async function newSession(
  process: RunningOutwardAcp,
  id: number,
  cwd: string,
  extra: Record<string, unknown> = {},
): Promise<JsonRpcResponse> {
  process.child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "session/new",
    params: { cwd, mcpServers: [], ...extra },
  })}\n`);
  return nextResponse(process);
}

function writePromptSession(
  process: RunningOutwardAcp,
  id: number,
  sessionId: string,
  text: string,
): void {
  process.child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "session/prompt",
    params: {
      sessionId,
      prompt: [{ type: "text", text }],
    },
  })}\n`);
}

async function promptSession(
  process: RunningOutwardAcp,
  id: number,
  sessionId: string,
  text: string,
): Promise<{ response: JsonRpcResponse; notifications: JsonRpcNotification[] }> {
  writePromptSession(process, id, sessionId, text);
  return readThroughResponse(process, id);
}

async function loadSession(
  process: RunningOutwardAcp,
  id: number,
  sessionId: string,
  cwd: string,
  extra: Record<string, unknown> = {},
): Promise<{ response: JsonRpcResponse; notifications: JsonRpcNotification[] }> {
  process.child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "session/load",
    params: { sessionId, cwd, mcpServers: [], ...extra },
  })}\n`);
  return readThroughResponse(process, id);
}

function cancelSession(process: RunningOutwardAcp, sessionId: string): void {
  process.child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    method: "session/cancel",
    params: { sessionId },
  })}\n`);
}

function conversationIdForSession(dbPath: string, sessionId: string): string {
  const db = openDb(dbPath, { databaseRole: "interactive" });
  try {
    const row = db.raw.prepare(`
      SELECT conversation_id
      FROM outward_acp_sessions
      WHERE session_id = ?
    `).get(sessionId) as { conversation_id: string } | undefined;
    if (!row) throw new Error(`missing outward session ${sessionId}`);
    return row.conversation_id;
  } finally {
    db.close();
  }
}

async function waitForRunningRun(dbPath: string, conversationId: string, timeoutMs = 2_000): Promise<void> {
  const db = openDb(dbPath, { databaseRole: "interactive" });
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const row = db.raw.prepare(`
        SELECT status
        FROM bridge_runs
        WHERE chat_id = ?
        ORDER BY started_at DESC
        LIMIT 1
      `).get(conversationId) as { status: string } | undefined;
      if (row?.status === "running") return;
      await delay(10);
    }
    throw new Error(`outward ACP run did not become active for ${conversationId}`);
  } finally {
    db.close();
  }
}

describe("outward ACP stdio boundary", () => {
  it("initializes conservatively and persists stable outward session identity across process restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-outward-acp-"));
    const dbPath = join(root, "bridge.sqlite");
    const cwd = join(root, "workspace");
    openDb(dbPath, { databaseRole: "interactive" }).close();

    let first: RunningOutwardAcp | null = null;
    let second: RunningOutwardAcp | null = null;
    try {
      first = startOutwardAcpProcess(dbPath);
      const initialized = await initialize(first, 1);
      expect(initialized).toMatchObject({
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: acp.PROTOCOL_VERSION,
          agentCapabilities: { loadSession: true },
          agentInfo: { name: "agent-bridge" },
        },
      });
      expect(initialized.result?.agentCapabilities).not.toHaveProperty("promptCapabilities");
      expect(initialized.result?.agentCapabilities).not.toHaveProperty("mcpCapabilities");

      const created = await newSession(first, 2, cwd);
      expect(created).toMatchObject({ jsonrpc: "2.0", id: 2, result: { sessionId: expect.any(String) } });
      const sessionId = created.result?.sessionId;
      expect(sessionId).toBeTruthy();

      const invalidCwd = await newSession(first, 3, "relative/workspace");
      expect(invalidCwd).toMatchObject({
        jsonrpc: "2.0",
        id: 3,
        error: { code: -32602, data: { field: "cwd" } },
      });

      const unsupportedDirectories = await newSession(first, 4, cwd, {
        additionalDirectories: [join(root, "other-workspace")],
      });
      expect(unsupportedDirectories).toMatchObject({
        jsonrpc: "2.0",
        id: 4,
        error: { code: -32602, data: { field: "additionalDirectories" } },
      });

      const unsupportedMcp = await newSession(first, 5, cwd, {
        mcpServers: [{ name: "test", command: "echo", args: [], env: [] }],
      });
      expect(unsupportedMcp).toMatchObject({
        jsonrpc: "2.0",
        id: 5,
        error: { code: -32602, data: { field: "mcpServers" } },
      });

      await stopProcess(first);
      first = null;

      const persisted = openDb(dbPath, { databaseRole: "interactive" });
      const row = persisted.raw.prepare(`
        SELECT session_id, conversation_id, cwd
        FROM outward_acp_sessions
        WHERE session_id = ?
      `).get(sessionId) as { session_id: string; conversation_id: string; cwd: string } | undefined;
      expect(row).toEqual({
        session_id: sessionId,
        conversation_id: expect.stringMatching(/^acp:[0-9a-f-]+$/),
        cwd,
      });
      expect(row?.conversation_id).not.toBe(sessionId);
      persisted.close();

      second = startOutwardAcpProcess(dbPath);
      await initialize(second, 6);
      const afterRestart = await newSession(second, 7, cwd);
      expect(afterRestart.result?.sessionId).toEqual(expect.any(String));
      expect(afterRestart.result?.sessionId).not.toBe(sessionId);
      await stopProcess(second);
      second = null;

      const reopened = openDb(dbPath, { databaseRole: "interactive" });
      expect(reopened.raw.prepare("SELECT COUNT(*) AS count FROM outward_acp_sessions").get()).toEqual({ count: 2 });
      expect(reopened.raw.prepare("SELECT conversation_id FROM outward_acp_sessions WHERE session_id = ?").get(sessionId)).toEqual({
        conversation_id: row?.conversation_id,
      });
      reopened.close();
    } finally {
      if (first) await stopProcess(first);
      if (second) await stopProcess(second);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resumes the same outward and inward sessions after restart without replaying the first answer", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-outward-acp-prompt-"));
    const dbPath = join(root, "bridge.sqlite");
    const providerStore = join(root, "provider-sessions.json");
    const env = providerEnv(providerStore);
    openDb(dbPath, { databaseRole: "interactive" }).close();

    let first: RunningOutwardAcp | null = null;
    let second: RunningOutwardAcp | null = null;
    try {
      first = startOutwardAcpProcess(dbPath, env);
      await initialize(first, 1);
      const created = await newSession(first, 2, root);
      const outwardSessionId = created.result?.sessionId;
      expect(outwardSessionId).toEqual(expect.any(String));

      const firstTurn = await promptSession(first, 3, outwardSessionId!, "PHASED first wire prompt");
      expect(firstTurn.response).toMatchObject({
        jsonrpc: "2.0",
        id: 3,
        result: { stopReason: "end_turn" },
      });
      const firstUpdates = firstTurn.notifications.filter((notification) => notification.method === "session/update");
      expect(firstUpdates.every((notification) => notification.params?.sessionId === outwardSessionId)).toBe(true);
      expect(JSON.stringify(firstUpdates)).not.toContain("thinking out loud");
      const firstAnswers = firstUpdates.filter((notification) => {
        const update = notification.params?.update as { sessionUpdate?: unknown } | undefined;
        return update?.sessionUpdate === "agent_message_chunk";
      });
      expect(firstAnswers).toHaveLength(1);
      expect(firstAnswers[0]?.params?.update).toMatchObject({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: expect.stringContaining("PHASED first wire prompt") },
      });

      await stopProcess(first);
      first = null;

      const conversationId = conversationIdForSession(dbPath, outwardSessionId!);
      const afterFirst = openDb(dbPath, { databaseRole: "interactive" });
      const firstProviderSessionId = afterFirst.getAcpSessionBinding(conversationId, "codex")?.acpSessionId;
      expect(firstProviderSessionId).toEqual(expect.any(String));
      afterFirst.close();

      second = startOutwardAcpProcess(dbPath, env);
      await initialize(second, 4);
      const secondTurn = await promptSession(second, 5, outwardSessionId!, "PHASED second wire prompt");
      expect(secondTurn.response).toMatchObject({
        jsonrpc: "2.0",
        id: 5,
        result: { stopReason: "end_turn" },
      });
      const secondUpdates = secondTurn.notifications.filter((notification) => notification.method === "session/update");
      expect(secondUpdates.length).toBeGreaterThan(0);
      expect(secondUpdates.every((notification) => notification.params?.sessionId === outwardSessionId)).toBe(true);
      expect(JSON.stringify(secondUpdates)).not.toContain("PHASED first wire prompt");
      expect(JSON.stringify(secondUpdates)).not.toContain("thinking out loud");
      expect(secondUpdates.some((notification) => {
        const update = notification.params?.update as { sessionUpdate?: unknown } | undefined;
        return update?.sessionUpdate === "tool_call";
      })).toBe(true);
      expect(secondUpdates.some((notification) => {
        const update = notification.params?.update as { sessionUpdate?: unknown } | undefined;
        return update?.sessionUpdate === "usage_update";
      })).toBe(true);
      const secondAnswers = secondUpdates.filter((notification) => {
        const update = notification.params?.update as { sessionUpdate?: unknown } | undefined;
        return update?.sessionUpdate === "agent_message_chunk";
      });
      expect(secondAnswers).toHaveLength(1);
      expect(secondAnswers[0]?.params?.update).toMatchObject({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: expect.stringContaining("PHASED second wire prompt") },
      });

      await stopProcess(second);
      second = null;

      const persisted = openDb(dbPath, { databaseRole: "interactive" });
      const finalProviderSessionId = persisted.getAcpSessionBinding(conversationId, "codex")?.acpSessionId;
      expect(finalProviderSessionId).toBe(firstProviderSessionId);
      expect(finalProviderSessionId).not.toBe(outwardSessionId);
      expect(persisted.raw.prepare(`
        SELECT COUNT(*) AS count
        FROM bridge_runs
        WHERE chat_id = ? AND status = 'done'
      `).get(conversationId)).toEqual({ count: 2 });
      persisted.close();
    } finally {
      if (first) await stopProcess(first);
      if (second) await stopProcess(second);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("replays durable history on session/load without creating a new Run or leaking provider identity", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-outward-acp-load-"));
    const dbPath = join(root, "bridge.sqlite");
    const providerStore = join(root, "provider-sessions.json");
    const env = providerEnv(providerStore);
    openDb(dbPath, { databaseRole: "interactive" }).close();

    let first: RunningOutwardAcp | null = null;
    let second: RunningOutwardAcp | null = null;
    try {
      first = startOutwardAcpProcess(dbPath, env);
      await initialize(first, 1);
      const created = await newSession(first, 2, root);
      const outwardSessionId = created.result?.sessionId!;
      const conversationId = conversationIdForSession(dbPath, outwardSessionId);

      await promptSession(first, 3, outwardSessionId, "LOAD first wire prompt");
      await stopProcess(first);
      first = null;

      const runCountBefore = openDb(dbPath, { databaseRole: "interactive" });
      const before = runCountBefore.raw.prepare(`
        SELECT COUNT(*) AS count FROM bridge_runs WHERE chat_id = ? AND status = 'done'
      `).get(conversationId) as { count: number };
      runCountBefore.close();
      expect(before.count).toBe(1);

      second = startOutwardAcpProcess(dbPath, env);
      await initialize(second, 4);

      const badCwd = await loadSession(second, 5, outwardSessionId, join(root, "wrong-workspace"));
      expect(badCwd.response).toMatchObject({
        jsonrpc: "2.0",
        id: 5,
        error: { code: -32602, data: { field: "cwd" } },
      });

      const unknownSession = await loadSession(second, 6, "not-a-real-session", root);
      expect(unknownSession.response).toMatchObject({
        jsonrpc: "2.0",
        id: 6,
        error: { code: -32602, data: { field: "sessionId" } },
      });

      const loaded = await loadSession(second, 7, outwardSessionId, root);
      expect(loaded.response).toMatchObject({ jsonrpc: "2.0", id: 7, result: {} });
      const replayUpdates = loaded.notifications.filter((notification) => notification.method === "session/update");
      expect(replayUpdates.every((notification) => notification.params?.sessionId === outwardSessionId)).toBe(true);
      expect(JSON.stringify(replayUpdates)).toContain("LOAD first wire prompt");
      expect(JSON.stringify(replayUpdates)).not.toMatch(/codex-session|acpSessionId/);

      const runCountAfterLoad = openDb(dbPath, { databaseRole: "interactive" });
      const afterLoad = runCountAfterLoad.raw.prepare(`
        SELECT COUNT(*) AS count FROM bridge_runs WHERE chat_id = ?
      `).get(conversationId) as { count: number };
      runCountAfterLoad.close();
      expect(afterLoad.count).toBe(1);

      const secondTurn = await promptSession(second, 8, outwardSessionId, "LOAD second wire prompt");
      expect(secondTurn.response).toMatchObject({ jsonrpc: "2.0", id: 8, result: { stopReason: "end_turn" } });
      const secondUpdates = secondTurn.notifications.filter((notification) => notification.method === "session/update");
      expect(JSON.stringify(secondUpdates)).not.toContain("LOAD first wire prompt");

      await stopProcess(second);
      second = null;
    } finally {
      if (first) await stopProcess(first);
      if (second) await stopProcess(second);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves inward provider permission requests under Bridge policy without ever exposing them to the outward client", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-outward-acp-permission-"));
    const dbPath = join(root, "bridge.sqlite");
    const providerStore = join(root, "provider-sessions.json");
    openDb(dbPath, { databaseRole: "interactive" }).close();

    let server: RunningOutwardAcp | null = null;
    try {
      // No CODEX_EXECUTION_MODE/BRIDGE_EXECUTION_MODE override -> defaults to
      // "safe", so the fake provider's non-read/search/think permission
      // request must be denied by Bridge policy, not by the outward client
      // (which is never asked at all).
      server = startOutwardAcpProcess(dbPath, providerEnv(providerStore, { FAKE_ACP_PERMISSION_ON: "ESCALATE" }));
      await initialize(server, 1);
      const created = await newSession(server, 2, root);
      const outwardSessionId = created.result?.sessionId!;

      const turn = await promptSession(server, 3, outwardSessionId, "ESCALATE the edit");
      expect(turn.response).toMatchObject({ jsonrpc: "2.0", id: 3, result: { stopReason: "end_turn" } });

      // The permission negotiation happens entirely on the inward Bridge<->provider
      // pipe; every message that actually crosses the outward stdio boundary is
      // a plain session/update notification, never a permission request/response.
      expect(turn.notifications.every((notification) => notification.method === "session/update")).toBe(true);
      expect(turn.notifications.some((notification) => notification.method === acp.methods.client.session.requestPermission)).toBe(false);

      await stopProcess(server);
      server = null;
    } finally {
      if (server) await stopProcess(server);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("honors server-configured trusted execution mode for inward permission requests, still never exposed outward", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-outward-acp-permission-trusted-"));
    const dbPath = join(root, "bridge.sqlite");
    const providerStore = join(root, "provider-sessions.json");
    openDb(dbPath, { databaseRole: "interactive" }).close();

    let server: RunningOutwardAcp | null = null;
    try {
      // The outward client has no field anywhere in session/new or
      // session/prompt to request trusted execution -- this is a
      // server-side/env-configured Bridge policy, not a client choice.
      server = startOutwardAcpProcess(dbPath, providerEnv(providerStore, {
        FAKE_ACP_PERMISSION_ON: "ESCALATE",
        CODEX_EXECUTION_MODE: "trusted",
      }));
      await initialize(server, 1);
      const created = await newSession(server, 2, root);
      const outwardSessionId = created.result?.sessionId!;

      const turn = await promptSession(server, 3, outwardSessionId, "ESCALATE the edit");
      expect(turn.response).toMatchObject({ jsonrpc: "2.0", id: 3, result: { stopReason: "end_turn" } });
      expect(turn.notifications.every((notification) => notification.method === "session/update")).toBe(true);
      expect(turn.notifications.some((notification) => notification.method === acp.methods.client.session.requestPermission)).toBe(false);

      await stopProcess(server);
      server = null;
    } finally {
      if (server) await stopProcess(server);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("routes session/cancel through Bridge execution ownership and settles the Run as cancelled", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-outward-acp-cancel-"));
    const dbPath = join(root, "bridge.sqlite");
    const providerStore = join(root, "provider-sessions.json");
    openDb(dbPath, { databaseRole: "interactive" }).close();

    let server: RunningOutwardAcp | null = null;
    try {
      server = startOutwardAcpProcess(dbPath, providerEnv(providerStore));
      await initialize(server, 1);
      const created = await newSession(server, 2, root);
      const outwardSessionId = created.result?.sessionId;
      expect(outwardSessionId).toEqual(expect.any(String));
      const conversationId = conversationIdForSession(dbPath, outwardSessionId!);

      writePromptSession(server, 3, outwardSessionId!, "HANG");
      await waitForRunningRun(dbPath, conversationId);
      cancelSession(server, outwardSessionId!);
      const turn = await readThroughResponse(server, 3);
      expect(turn.response).toMatchObject({
        jsonrpc: "2.0",
        id: 3,
        result: { stopReason: "cancelled" },
      });
      expect(JSON.stringify(turn.notifications)).not.toContain("agent_message_chunk");

      await stopProcess(server);
      server = null;

      const persisted = openDb(dbPath, { databaseRole: "interactive" });
      expect(persisted.raw.prepare(`
        SELECT status
        FROM bridge_runs
        WHERE chat_id = ?
        ORDER BY started_at DESC
        LIMIT 1
      `).get(conversationId)).toEqual({ status: "cancelled" });
      persisted.close();
    } finally {
      if (server) await stopProcess(server);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cancels and fully settles an active Run before closing the database on client disconnect", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-outward-acp-disconnect-"));
    const dbPath = join(root, "bridge.sqlite");
    const providerStore = join(root, "provider-sessions.json");
    openDb(dbPath, { databaseRole: "interactive" }).close();

    let server: RunningOutwardAcp | null = null;
    try {
      server = startOutwardAcpProcess(dbPath, providerEnv(providerStore));
      await initialize(server, 1);
      const created = await newSession(server, 2, root);
      const outwardSessionId = created.result?.sessionId;
      expect(outwardSessionId).toEqual(expect.any(String));
      const conversationId = conversationIdForSession(dbPath, outwardSessionId!);

      writePromptSession(server, 3, outwardSessionId!, "HANG");
      await waitForRunningRun(dbPath, conversationId);
      server.child.stdin.end();
      await waitForExit(server);
      server.output.close();
      server = null;

      const persisted = openDb(dbPath, { databaseRole: "interactive" });
      expect(persisted.raw.prepare(`
        SELECT status
        FROM bridge_runs
        WHERE chat_id = ?
        ORDER BY started_at DESC
        LIMIT 1
      `).get(conversationId)).toEqual({ status: "cancelled" });
      persisted.close();
    } finally {
      if (server) await stopProcess(server);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
