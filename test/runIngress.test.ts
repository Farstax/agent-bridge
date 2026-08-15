import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { openDb } from "../src/db.js";
import { type as eventType } from "../src/events/types.js";
import {
  acceptRunIngressRequest,
  executeRunIngressRequest,
  RunIngressAuthenticationError,
  RunIngressRequestError,
  RunIngressServer,
  type RunIngressEngine,
  type RunIngressRequest,
} from "../src/runIngress.js";

const TOKEN = "trusted-ingress-token";
const paths: string[] = [];

function setup() {
  const path = join(tmpdir(), `run-ingress-${Date.now()}-${Math.random()}.sqlite`);
  paths.push(path);
  return openDb(path, { serviceId: "test-ingress", runId: "test-process" });
}

function request(overrides: Partial<RunIngressRequest> = {}): RunIngressRequest {
  return {
    requestId: "request-1",
    idempotencyKey: "caller:request-1",
    scopeKey: "workspace-1",
    prompt: "Inspect the bounded problem and report the next action.",
    token: TOKEN,
    ...overrides,
  };
}

function fakeEngine(result = "no action") : RunIngressEngine {
  return {
    executeSurfaceNeutralTurn: async (input) => {
      input.collect(eventType.runCompleted({
        runId: input.runId,
        bot: "claude",
        chatId: input.chatKey,
        text: result,
        sessionId: null,
      }));
      return { text: result, sessionId: null, memoryCandidates: [], nativeSessionMode: "fresh" };
    },
  } as RunIngressEngine;
}

afterEach(() => {
  for (const path of paths.splice(0)) try { rmSync(path); } catch { /* already removed */ }
});

describe("authenticated ordinary Run ingress", () => {
  it("rejects unauthenticated requests before creating durable state", () => {
    const db = setup();
    expect(() => acceptRunIngressRequest(db, request({ token: "wrong" }), { expectedToken: TOKEN })).toThrow(RunIngressAuthenticationError);
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM bridge_runs").get()).toEqual({ count: 0 });
    db.close();
  });

  it("rejects malformed and oversized requests", () => {
    const db = setup();
    expect(() => acceptRunIngressRequest(db, request({ scopeKey: "bad scope" }), { expectedToken: TOKEN })).toThrow(RunIngressRequestError);
    expect(() => acceptRunIngressRequest(db, request({ prompt: "x".repeat(12_001) }), { expectedToken: TOKEN })).toThrow(RunIngressRequestError);
    db.close();
  });

  it("creates one ordinary Run and replays the same Run for duplicate delivery", () => {
    const db = setup();
    const first = acceptRunIngressRequest(db, request(), { expectedToken: TOKEN, runId: () => "run-1" });
    const second = acceptRunIngressRequest(db, request({ requestId: "retry" }), { expectedToken: TOKEN, runId: () => "run-2" });
    expect(first).toMatchObject({ runId: "run-1", created: true });
    expect(second).toMatchObject({ runId: "run-1", created: false, receiptId: first.receiptId });
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM bridge_runs").get()).toEqual({ count: 1 });
    db.close();
  });

  it("executes through the surface-neutral engine and returns its bounded terminal result", async () => {
    const db = setup();
    const accepted = acceptRunIngressRequest(db, request(), { expectedToken: TOKEN, runId: () => "run-1" });
    const response = await executeRunIngressRequest(db, accepted.receiptId, fakeEngine("bounded result"), { bot: "claude" });
    expect(response).toEqual({ runId: "run-1", status: "done", result: "bounded result" });
    expect(db.getRun("run-1").status).toBe("done");
    expect(db.getEventsForRun("run-1").some((event) => event.type === "run.completed")).toBe(true);
    db.close();
  });

  it("does not execute a terminal Run again on replay", async () => {
    const db = setup();
    const accepted = acceptRunIngressRequest(db, request(), { expectedToken: TOKEN, runId: () => "run-1" });
    const engine = fakeEngine("once");
    await executeRunIngressRequest(db, accepted.receiptId, engine);
    const replay = await executeRunIngressRequest(db, accepted.receiptId, {
      executeSurfaceNeutralTurn: async () => { throw new Error("must not execute"); },
    });
    expect(replay).toEqual({ runId: "run-1", status: "done", result: "once" });
    db.close();
  });

  it("fences a provider/start failure into a terminal failed Run", async () => {
    const db = setup();
    const accepted = acceptRunIngressRequest(db, request(), { expectedToken: TOKEN, runId: () => "run-1" });
    const response = await executeRunIngressRequest(db, accepted.receiptId, {
      executeSurfaceNeutralTurn: async () => { throw new Error("provider unavailable"); },
    });
    expect(response).toEqual({ runId: "run-1", status: "failed", errorClass: "execution" });
    expect(db.getRun("run-1").status).toBe("failed");
    db.close();
  });

  it("exposes only the token-authenticated bounded socket contract", async () => {
    const socketPath = join(tmpdir(), `run-ingress-${Date.now()}-${Math.random()}.sock`);
    const server = new RunIngressServer({
      socketPath,
      expectedToken: TOKEN,
      accept: (input) => ({ receiptId: 1, runId: input.requestId, created: true }),
      execute: async () => ({ runId: "run-1", status: "done", result: "bounded" }),
    });
    await server.start();
    const send = (input: RunIngressRequest) => new Promise<string>((resolve, reject) => {
      const socket = createConnection(socketPath);
      let output = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => { output += chunk; });
      socket.once("error", reject);
      socket.on("end", () => resolve(output));
      socket.end(JSON.stringify(input));
    });
    expect(JSON.parse(await send(request({ token: "wrong" })))).toMatchObject({ ok: false });
    expect(JSON.parse(await send(request()))).toMatchObject({ ok: true, response: { status: "done", result: "bounded" } });
    await server.close();
  });
});
