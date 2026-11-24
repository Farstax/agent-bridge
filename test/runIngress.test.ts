import { afterEach, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { existsSync, readFileSync, rmSync, mkdtempSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
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
  it("is hosted by the interactive runtime after the health entrypoint is removed", () => {
    const interactive = fileURLToPath(new URL("../src/index-interactive.ts", import.meta.url));
    const health = fileURLToPath(new URL("../src/index-health.ts", import.meta.url));
    const source = readFileSync(interactive, "utf8");
    expect(source).toContain("new RunIngressServer");
    expect(source).toContain("BRIDGE_RUN_INGRESS_SOCKET");
    expect(source).toContain("BRIDGE_RUN_INGRESS_TOKEN");
    expect(existsSync(health)).toBe(false);
  });

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

  it("rejects a duplicate key belonging to another receipt authority", () => {
    const db = setup();
    try {
      db.insertRun("foreign-run", { surfaceIdentity: "telegram:interactive", chatKey: "other" }, "codex");
      const receipt = db.createEventReceipt({ event_id: "foreign", source: "telegram", event_kind: "message", idempotency_key: request().idempotencyKey, received_at: "2020-01-01T00:00:00Z", occurred_at: "2020-01-01T00:00:00Z", payload_json: "{}", authority_scope: "telegram:interactive" });
      db.linkEventReceiptRun(receipt.id, "foreign-run");
      expect(() => acceptRunIngressRequest(db, request(), { expectedToken: TOKEN })).toThrow();
    } finally { db.close(); }
  });

  it("rejects a duplicate key from a different ingress scope", () => {
    const db = setup();
    try {
      acceptRunIngressRequest(db, request(), { expectedToken: TOKEN, runId: () => "run-1" });
      expect(() => acceptRunIngressRequest(db, request({ scopeKey: "other-workspace" }), { expectedToken: TOKEN })).toThrow(RunIngressRequestError);
    } finally { db.close(); }
  });

  it("admits one Run across concurrent processes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ingress-race-"));
    const path = join(dir, "bridge.sqlite");
    const initial = openDb(path); initial.close();
    const source = `import {openDb} from './src/db.ts'; import {acceptRunIngressRequest} from './src/runIngress.ts'; import fs from 'node:fs'; const [path, gate, id] = process.argv.slice(1); const db = openDb(path); process.stdout.write('ready\\n'); while (!fs.existsSync(gate)) await new Promise(r => setTimeout(r, 5)); const out = acceptRunIngressRequest(db, ${JSON.stringify(request())}, {expectedToken:${JSON.stringify(TOKEN)}, runId:()=>id}); db.close(); process.stdout.write(JSON.stringify(out)+'\\n');`;
    const children = ["one", "two"].map((id) => spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source, path, join(dir, "gate"), id], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] }));
    try {
      const results = children.map((child) => new Promise<string>((resolve, reject) => {
        let out = "", err = "";
        child.stdout.on("data", (chunk) => { out += chunk; });
        child.stderr.on("data", (chunk) => { err += chunk; });
        child.on("error", reject);
        child.on("exit", (code) => code === 0 ? resolve(out) : reject(new Error(err)));
      }));
      await new Promise<void>((resolve, reject) => {
        let ready = 0;
        const timeout = setTimeout(() => reject(new Error("workers not ready")), 15_000);
        for (const child of children) child.stdout.once("data", () => { if (++ready === 2) { clearTimeout(timeout); resolve(); } });
      });
      writeFileSync(join(dir, "gate"), "go");
      const admitted = (await Promise.all(results)).map((out) => JSON.parse(out.trim().split("\n").at(-1)!));
      expect(admitted.map((v) => v.created).sort()).toEqual([false, true]);
      expect(admitted[0].runId).toBe(admitted[1].runId);
      const verify = openDb(path);
      try { expect(verify.raw.prepare("SELECT COUNT(*) AS count FROM bridge_runs").get()).toEqual({ count: 1 }); } finally { verify.close(); }
    } finally { for (const child of children) child.kill(); rmSync(dir, { recursive: true, force: true }); }
  }, 30_000);

  it("rolls back receipt admission when the process dies before linking the Run", () => {
    const dir = mkdtempSync(join(tmpdir(), "ingress-crash-"));
    const path = join(dir, "bridge.sqlite");
    const initial = openDb(path); initial.close();
    try {
      const code = `import {openDb} from './src/db.ts';import {acceptRunIngressRequest} from './src/runIngress.ts';const db=openDb(process.argv[1]);acceptRunIngressRequest(db,${JSON.stringify(request())},{expectedToken:${JSON.stringify(TOKEN)},runId:()=>{process.kill(process.pid,'SIGKILL');throw new Error('unreachable')}});`;
      const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code, path], { cwd: process.cwd(), timeout: 15_000, encoding: "utf8" });
      expect(result.signal).toBe("SIGKILL");
      const reopened = openDb(path);
      try {
        expect(reopened.getEventReceiptByIdempotencyKey(request().idempotencyKey)).toBeNull();
        expect(acceptRunIngressRequest(reopened, request(), { expectedToken: TOKEN, runId: () => "recovered" })).toMatchObject({ created: true, runId: "recovered" });
      } finally { reopened.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 20_000);

  it("rolls back the receipt if Run admission fails so a retry can proceed", () => {
    const db = setup();
    try {
      expect(() => acceptRunIngressRequest(db, request(), { expectedToken: TOKEN, runId: () => { throw new Error("admission failed"); } })).toThrow("admission failed");
      expect(db.getEventReceiptByIdempotencyKey(request().idempotencyKey)).toBeNull();
      expect(acceptRunIngressRequest(db, request(), { expectedToken: TOKEN, runId: () => "retry-run" })).toMatchObject({ runId: "retry-run", created: true });
    } finally { db.close(); }
  });

  it("preserves a custom ACP provider selected by the interactive runtime", () => {
    const db = setup();
    const accepted = acceptRunIngressRequest(db, request(), {
      expectedToken: TOKEN,
      bot: "custom-acp",
      runId: () => "run-custom",
    });
    expect(db.getRun(accepted.runId).bot).toBe("custom-acp");
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

  it("fails closed when durable request or terminal evidence is malformed", async () => {
    const db = setup();
    const accepted = acceptRunIngressRequest(db, request(), { expectedToken: TOKEN, runId: () => "run-1" });
    db.raw.prepare("UPDATE event_receipts SET payload_json = ? WHERE id = ?").run("{}", accepted.receiptId);
    await expect(executeRunIngressRequest(db, accepted.receiptId, fakeEngine())).resolves.toMatchObject({
      runId: "run-1", status: "failed", errorClass: "ambiguous",
    });
    expect(db.getRun("run-1").status).toBe("failed");
    db.close();
  });
});
