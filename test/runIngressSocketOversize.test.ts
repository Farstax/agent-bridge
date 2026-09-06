import { afterEach, describe, expect, it, vi } from "vitest";
import { createConnection } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { RunIngressServer } from "../src/runIngress.js";

const socketPaths: string[] = [];
const servers: RunIngressServer[] = [];

async function exchange(socketPath: string, payload: string, tolerateReset = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let response = "";
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(response);
    };
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { response += chunk; });
    socket.on("connect", () => socket.end(payload));
    socket.on("end", finish);
    socket.on("close", finish);
    socket.on("error", (error) => {
      if (tolerateReset) finish();
      else reject(error);
    });
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close().catch(() => {})));
  for (const path of socketPaths.splice(0)) rmSync(path, { force: true });
  vi.restoreAllMocks();
});

describe("RunIngressServer oversized request handling", () => {
  it("rejects an oversized connection without crashing and accepts the next valid request", async () => {
    const socketPath = join(tmpdir(), `agent-bridge-ingress-${process.pid}-${Date.now()}-${Math.random()}.sock`);
    socketPaths.push(socketPath);
    const accept = vi.fn(() => ({ receiptId: 1, runId: "run-1", created: true }));
    const execute = vi.fn(async () => ({ runId: "run-1", status: "done" as const, result: "ok" }));
    const server = new RunIngressServer({ socketPath, expectedToken: "secret", accept, execute });
    servers.push(server);
    await server.start();

    await exchange(socketPath, "x".repeat(20_000), true);
    expect(accept).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();

    const valid = JSON.stringify({
      requestId: "req-1",
      idempotencyKey: "idem-1",
      scopeKey: "scope-1",
      prompt: "hello",
      token: "secret",
    });
    const response = await exchange(socketPath, valid);
    expect(JSON.parse(response.trim())).toEqual({
      ok: true,
      response: { runId: "run-1", status: "done", result: "ok" },
    });
    expect(accept).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
