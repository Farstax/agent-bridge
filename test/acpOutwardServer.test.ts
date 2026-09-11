import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import * as acp from "@agentclientprotocol/sdk";
import { openDb } from "../src/db.js";

type JsonRpcResponse = {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly result?: {
    readonly protocolVersion?: number;
    readonly agentCapabilities?: Record<string, unknown>;
    readonly agentInfo?: { readonly name?: string };
    readonly sessionId?: string;
  };
  readonly error?: {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
  };
};

type RunningOutwardAcp = {
  child: ChildProcessWithoutNullStreams;
  output: Interface;
  lines: AsyncIterator<string>;
  stderr: () => string;
};

function startOutwardAcpProcess(dbPath: string): RunningOutwardAcp {
  const child = spawn(process.execPath, ["--import", "tsx", "src/acpServer/stdio.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DB_PATH: dbPath,
      NODE_ENV: "test",
      AGENT_BRIDGE_INSTALLATION_ID: "",
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

async function nextResponse(process: RunningOutwardAcp): Promise<JsonRpcResponse> {
  const next = await process.lines.next();
  if (next.done) {
    throw new Error(`outward ACP process closed stdout before responding; stderr=${process.stderr()}`);
  }
  return JSON.parse(next.value) as JsonRpcResponse;
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
          agentCapabilities: { loadSession: false },
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
});
