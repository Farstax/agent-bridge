import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import * as acp from "@agentclientprotocol/sdk";

type JsonRpcResponse = {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly result?: {
    readonly protocolVersion?: number;
    readonly agentCapabilities?: Record<string, unknown>;
    readonly agentInfo?: { readonly name?: string };
  };
  readonly error?: {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
  };
};

function startOutwardAcpProcess(): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ["--import", "tsx", "src/acpServer/stdio.ts"], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function processExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function stopProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (processExited(child)) return;
  child.stdin.end();
  const gracefulExit = once(child, "exit");
  child.kill("SIGTERM");
  await Promise.race([gracefulExit, delay(1_000)]);
  if (processExited(child)) return;

  const forcedExit = once(child, "exit");
  child.kill("SIGKILL");
  await forcedExit;
}

async function nextResponse(lines: AsyncIterator<string>, stderr: () => string): Promise<JsonRpcResponse> {
  const next = await lines.next();
  if (next.done) {
    throw new Error(`outward ACP process closed stdout before responding; stderr=${stderr()}`);
  }
  return JSON.parse(next.value) as JsonRpcResponse;
}

describe("outward ACP stdio boundary", () => {
  it("serves conservative initialize and rejects unsupported session methods with JSON-RPC method-not-found", async () => {
    const child = startOutwardAcpProcess();
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const output = createInterface({ input: child.stdout });
    const lines = output[Symbol.asyncIterator]();

    try {
      child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
        },
      })}\n`);

      const initialized = await nextResponse(lines, () => stderr);
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

      child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "session/new",
        params: {
          cwd: "/tmp",
          mcpServers: [],
        },
      })}\n`);

      const unsupported = await nextResponse(lines, () => stderr);
      expect(unsupported).toMatchObject({
        jsonrpc: "2.0",
        id: 2,
        error: {
          code: -32601,
          data: { method: "session/new" },
        },
      });
    } finally {
      output.close();
      await stopProcess(child);
    }
  });
});
