import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as acp from "@agentclientprotocol/sdk";
import { openDb, type BridgeDb } from "../src/db.js";
import { type as eventType } from "../src/events/types.js";
import { getHandoffReason } from "../src/handoffState.js";
import { OutwardAcpSessionRepository } from "../src/repositories/outwardAcpSessionRepository.js";
import { createOutwardAcpAgent, WORKSTREAM_METHODS, type OutwardAcpSessionStore } from "../src/acpServer/app.js";
import { BridgeOutwardAcpPromptExecutor, OUTWARD_ACP_SURFACE } from "../src/acpServer/execution.js";
import type { BotKind } from "../src/types.js";

type Fixture = {
  root: string;
  dbPath: string;
  db: BridgeDb;
  repo: OutwardAcpSessionRepository;
  sessions: OutwardAcpSessionStore;
};

const opened: Fixture[] = [];

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "agent-bridge-workstreams-"));
  const dbPath = join(root, "bridge.sqlite");
  const db = openDb(dbPath, { databaseRole: "interactive" });
  const repo = new OutwardAcpSessionRepository(db.raw);
  const f: Fixture = { root, dbPath, db, repo, sessions: {} as OutwardAcpSessionStore };
  const makeSessions = (): OutwardAcpSessionStore => ({
    create: (session) => f.repo.create(session),
    get: (id) => f.repo.get(id),
    list: (cwd, options) => f.repo.list(cwd, options),
    update: (id, change) => f.repo.update(id, change),
    history: (conversationId) => f.db.getRecentConvTurns(conversationId, 200, undefined, OUTWARD_ACP_SURFACE)
      .map((turn) => ({ role: turn.role as "user" | "assistant", text: turn.text })),
  });
  f.sessions = makeSessions();
  opened.push(f);
  return f;
}

afterEach(() => {
  for (const f of opened.splice(0)) {
    try { f.db.close(); } catch { /* already closed */ }
    rmSync(f.root, { recursive: true, force: true });
  }
});

type Attempt = { provider: BotKind; release?: Promise<void>; fail?: boolean };

function executor(db: BridgeDb, attempts: Attempt[], options: { available?: (p: BotKind) => boolean } = {}) {
  let n = 0;
  const prefix = `run-${++executors}`;
  return new BridgeOutwardAcpPromptExecutor({
    db,
    providerChain: ["codex", "claude"] as const,
    isProviderAvailable: options.available,
    runId: () => `${prefix}-${++n}`,
    createEngine: (_session, attemptProvider) => ({
      executeSurfaceNeutralTurn: async (input) => {
        const attempt: Attempt = { provider: attemptProvider };
        attempts.push(attempt);
        input.collect(eventType.runStarted({
          runId: input.runId,
          bot: attemptProvider,
          chatId: String(input.chatId),
          chatKey: input.chatKey,
          command: `${attemptProvider}-acp`,
          cwd: "/",
          model: null,
        }));
        const gate = pendingGates.shift();
        if (gate) await gate;
        if (failNext) {
          failNext = false;
          throw new Error("provider failed");
        }
        return { text: `answer from ${attemptProvider}`, sessionId: `${attemptProvider}-session`, stopReason: "end_turn" };
      },
    }),
  });
}

let executors = 0;
let pendingGates: Promise<void>[] = [];
let failNext = false;

async function call<T>(app: ReturnType<typeof createOutwardAcpAgent>, method: string, params: unknown): Promise<T> {
  return acp.client({ name: "desk-test" }).connectWith(app, (agent) => agent.request<T>(method, params));
}

describe("outward ACP Workstreams (#1101)", () => {
  it("advertises Workstream controls only when wired", async () => {
    const f = fixture();
    const wired = createOutwardAcpAgent({ sessions: f.sessions, workstreams: executor(f.db, []) });
    const init = await acp.client({ name: "t" }).connectWith(wired, (agent) =>
      agent.request(acp.methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} }));
    expect(init.agentCapabilities?._meta).toEqual({ "agent-bridge": { workstreams: 1 } });

    const plain = createOutwardAcpAgent({ sessions: f.sessions });
    const plainInit = await acp.client({ name: "t" }).connectWith(plain, (agent) =>
      agent.request(acp.methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} }));
    expect(plainInit.agentCapabilities?._meta).toBeUndefined();
    await expect(call(plain, WORKSTREAM_METHODS.list, { cwd: f.root })).rejects.toMatchObject({ code: -32601 });
  });

  it("lists, renames, archives and restores Workstreams bound to stable conversation IDs across restart", async () => {
    const f = fixture();
    const app = createOutwardAcpAgent({ sessions: f.sessions, workstreams: executor(f.db, []) });
    const a = await acp.client({ name: "t" }).connectWith(app, (agent) =>
      agent.request(acp.methods.agent.session.new, { cwd: f.root, mcpServers: [] }));
    const b = await acp.client({ name: "t" }).connectWith(app, (agent) =>
      agent.request(acp.methods.agent.session.new, { cwd: f.root, mcpServers: [] }));
    const other = mkdtempSync(join(tmpdir(), "agent-bridge-workstreams-other-"));
    try {
      await acp.client({ name: "t" }).connectWith(app, (agent) =>
        agent.request(acp.methods.agent.session.new, { cwd: other, mcpServers: [] }));
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
    const conversationA = f.repo.get(a.sessionId)!.conversationId;

    await call(app, WORKSTREAM_METHODS.update, { sessionId: a.sessionId, cwd: f.root, title: "  Release notes  " });
    await call(app, WORKSTREAM_METHODS.update, { sessionId: b.sessionId, cwd: f.root, archived: true });

    const visible = await call<{ workstreams: Array<{ sessionId: string; title: string | null; conversationId: string; status: { state: string } }> }>(
      app, WORKSTREAM_METHODS.list, { cwd: f.root });
    expect(visible.workstreams.map((w) => w.sessionId)).toEqual([a.sessionId]);
    expect(visible.workstreams[0]).toMatchObject({ title: "Release notes", conversationId: conversationA, status: { state: "idle" } });

    const all = await call<{ workstreams: Array<{ sessionId: string; archived: boolean }> }>(
      app, WORKSTREAM_METHODS.list, { cwd: f.root, includeArchived: true });
    expect(all.workstreams.map((w) => [w.sessionId, w.archived]).sort()).toEqual(
      [[a.sessionId, false], [b.sessionId, true]].sort());

    await call(app, WORKSTREAM_METHODS.update, { sessionId: b.sessionId, cwd: f.root, archived: false });

    // Reopen: identity and metadata are durable, not process memory.
    f.db.close();
    const db = openDb(f.dbPath, { databaseRole: "interactive" });
    f.db = db;
    const repo = new OutwardAcpSessionRepository(db.raw);
    expect(repo.get(a.sessionId)).toMatchObject({ conversationId: conversationA, title: "Release notes", archivedAt: null });
    expect(repo.list(f.root).map((s) => s.sessionId).sort()).toEqual([a.sessionId, b.sessionId].sort());
  });

  it("fails closed for unknown sessions, cwd mismatch and invalid input", async () => {
    const f = fixture();
    f.repo.create({ sessionId: "s1", conversationId: "acp:c1", cwd: f.root });
    const app = createOutwardAcpAgent({ sessions: f.sessions, workstreams: executor(f.db, []) });
    await expect(call(app, WORKSTREAM_METHODS.status, { sessionId: "missing", cwd: f.root })).rejects.toMatchObject({ code: -32602 });
    await expect(call(app, WORKSTREAM_METHODS.status, { sessionId: "s1", cwd: "/elsewhere" })).rejects.toMatchObject({ code: -32602 });
    await expect(call(app, WORKSTREAM_METHODS.list, { cwd: "relative" })).rejects.toMatchObject({ code: -32602 });
    for (const title of ["", "   ", "a\nb", "x".repeat(201), 5]) {
      await expect(call(app, WORKSTREAM_METHODS.update, { sessionId: "s1", cwd: f.root, title })).rejects.toMatchObject({ code: -32602 });
    }
    await expect(call(app, WORKSTREAM_METHODS.update, { sessionId: "s1", cwd: f.root })).rejects.toMatchObject({ code: -32602 });
    expect(f.repo.get("s1")!.title).toBeNull();
  });

  it("switches the provider per Workstream durably, with handoff, without touching other Workstreams", async () => {
    const f = fixture();
    f.repo.create({ sessionId: "s1", conversationId: "acp:c1", cwd: f.root });
    f.repo.create({ sessionId: "s2", conversationId: "acp:c2", cwd: f.root });
    const attempts: Attempt[] = [];
    const exec = executor(f.db, attempts);
    const app = createOutwardAcpAgent({ sessions: f.sessions, promptExecutor: exec, workstreams: exec });
    const prompt = (sessionId: string) => acp.client({ name: "t" }).connectWith(app, (agent) =>
      agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "hi" }] }));

    await prompt("s1");
    expect(attempts.at(-1)?.provider).toBe("codex");

    const switched = await call<{ status: { selectedProvider: string } }>(
      app, WORKSTREAM_METHODS.selectProvider, { sessionId: "s1", cwd: f.root, provider: "claude" });
    expect(switched.status.selectedProvider).toBe("claude");
    expect(getHandoffReason(f.db, OUTWARD_ACP_SURFACE, "acp:c1", "claude")).toBe("manual_switch");

    await prompt("s1");
    expect(attempts.at(-1)?.provider).toBe("claude");
    await prompt("s2");
    expect(attempts.at(-1)?.provider).toBe("codex");

    // Same conversation ID; the Run is attributed to the selected provider.
    const run = f.db.getLatestRunForConversation({ surfaceIdentity: OUTWARD_ACP_SURFACE, chatKey: "acp:c1" });
    expect(run).toMatchObject({ bot: "claude", status: "done" });

    // A restarted executor reads the durable selection.
    const restarted: Attempt[] = [];
    const exec2 = executor(f.db, restarted);
    const app2 = createOutwardAcpAgent({ sessions: f.sessions, promptExecutor: exec2, workstreams: exec2 });
    await acp.client({ name: "t" }).connectWith(app2, (agent) =>
      agent.request(acp.methods.agent.session.prompt, { sessionId: "s1", prompt: [{ type: "text", text: "again" }] }));
    expect(restarted.at(-1)?.provider).toBe("claude");
  });

  it("rejects unconfigured or unavailable providers and never retargets an in-flight Run", async () => {
    const f = fixture();
    f.repo.create({ sessionId: "s1", conversationId: "acp:c1", cwd: f.root });
    const attempts: Attempt[] = [];
    const exec = executor(f.db, attempts, { available: (p) => p === "codex" });
    const app = createOutwardAcpAgent({ sessions: f.sessions, promptExecutor: exec, workstreams: exec });

    await expect(call(app, WORKSTREAM_METHODS.selectProvider, { sessionId: "s1", cwd: f.root, provider: "grok" }))
      .rejects.toMatchObject({ code: -32602 });
    await expect(call(app, WORKSTREAM_METHODS.selectProvider, { sessionId: "s1", cwd: f.root, provider: "claude" }))
      .rejects.toMatchObject({ code: -32602 });

    let release!: () => void;
    pendingGates = [new Promise<void>((resolve) => { release = resolve; })];
    const client = acp.client({ name: "t" });
    const inFlight = client.connectWith(app, async (agent) => {
      const pending = agent.request(acp.methods.agent.session.prompt, { sessionId: "s1", prompt: [{ type: "text", text: "long" }] });
      await new Promise((resolve) => setTimeout(resolve, 20));
      const status = await agent.request<{ status: { state: string } }>(WORKSTREAM_METHODS.status, { sessionId: "s1", cwd: f.root });
      expect(status.status.state).toBe("running");
      await expect(agent.request(WORKSTREAM_METHODS.selectProvider, { sessionId: "s1", cwd: f.root, provider: "codex" }))
        .rejects.toMatchObject({ code: -32002 });
      release();
      return pending;
    });
    await inFlight;
    expect(attempts.map((a) => a.provider)).toEqual(["codex"]);
    const status = await call<{ status: { state: string; lastRun: { status: string } } }>(
      app, WORKSTREAM_METHODS.status, { sessionId: "s1", cwd: f.root });
    expect(status.status).toMatchObject({ state: "idle", lastRun: { status: "done" } });
  });

  it("reports the provider the next Run actually uses after fallback", async () => {
    const f = fixture();
    f.repo.create({ sessionId: "s1", conversationId: "acp:c1", cwd: f.root });
    const attempts: Attempt[] = [];
    let codexUp = true;
    const exec = executor(f.db, attempts, { available: (p) => p === "claude" || codexUp });
    const app = createOutwardAcpAgent({ sessions: f.sessions, promptExecutor: exec, workstreams: exec });
    const prompt = () => acp.client({ name: "t" }).connectWith(app, (agent) =>
      agent.request(acp.methods.agent.session.prompt, { sessionId: "s1", prompt: [{ type: "text", text: "hi" }] }));

    expect(exec.status(f.repo.get("s1")!)).toMatchObject({ selectedProvider: "codex", nextProvider: "codex" });
    await prompt();
    codexUp = false;
    const degraded = exec.status(f.repo.get("s1")!);
    expect(degraded).toMatchObject({ selectedProvider: "codex", nextProvider: "claude" });
    expect(degraded.providers).toEqual([{ id: "codex", available: false }, { id: "claude", available: true }]);
    await prompt();
    expect(attempts.map((a) => a.provider)).toEqual(["codex", "claude"]);

    // An explicit selection resets the head; status and execution agree.
    codexUp = true;
    exec.selectProvider(f.repo.get("s1")!, "claude");
    expect(exec.status(f.repo.get("s1")!)).toMatchObject({ selectedProvider: "claude", nextProvider: "claude" });
    await prompt();
    expect(attempts.at(-1)?.provider).toBe("claude");
  });

  it("reports failed and attention states only from durable Run records", async () => {
    const f = fixture();
    f.repo.create({ sessionId: "s1", conversationId: "acp:c1", cwd: f.root });
    const exec = executor(f.db, []);
    const app = createOutwardAcpAgent({ sessions: f.sessions, promptExecutor: exec, workstreams: exec });
    failNext = true;
    await expect(acp.client({ name: "t" }).connectWith(app, (agent) =>
      agent.request(acp.methods.agent.session.prompt, { sessionId: "s1", prompt: [{ type: "text", text: "x" }] })))
      .rejects.toMatchObject({ code: -32001 });
    expect(exec.status(f.repo.get("s1")!).state).toBe("failed");

    await acp.client({ name: "t" }).connectWith(app, (agent) =>
      agent.request(acp.methods.agent.session.prompt, { sessionId: "s1", prompt: [{ type: "text", text: "y" }] }));
    expect(exec.status(f.repo.get("s1")!).state).toBe("idle");
    // A provider-recorded "blocked" disposition is the explicit attention signal.
    const runId = f.db.getLatestRunForConversation({ surfaceIdentity: OUTWARD_ACP_SURFACE, chatKey: "acp:c1" })!.run_id;
    f.db.raw.prepare("UPDATE bridge_runs SET outcome_status = 'blocked' WHERE run_id = ?").run(runId);
    expect(exec.status(f.repo.get("s1")!)).toMatchObject({ state: "attention", lastRun: { outcome: "blocked" } });
  });

  it("recovers an accepted failed prompt and a safe reason after database restart", async () => {
    const f = fixture();
    f.repo.create({ sessionId: "s1", conversationId: "acp:c1", cwd: f.root });
    const exec = executor(f.db, []);
    const app = createOutwardAcpAgent({ sessions: f.sessions, promptExecutor: exec, workstreams: exec });
    failNext = true;
    await expect(acp.client({ name: "t" }).connectWith(app, (agent) =>
      agent.request(acp.methods.agent.session.prompt, { sessionId: "s1", prompt: [{ type: "text", text: "accepted before failure" }] })))
      .rejects.toMatchObject({ code: -32001 });

    expect(f.sessions.history!("acp:c1")).toEqual([{ role: "user", text: "accepted before failure" }]);
    expect(exec.status(f.repo.get("s1")!).lastRun).toMatchObject({ status: "failed", error: expect.any(String) });

    f.db.close();
    f.db = openDb(f.dbPath, { databaseRole: "interactive" });
    f.repo = new OutwardAcpSessionRepository(f.db.raw);
    f.sessions = {
      create: (session) => f.repo.create(session),
      get: (id) => f.repo.get(id),
      list: (cwd, options) => f.repo.list(cwd, options),
      update: (id, change) => f.repo.update(id, change),
      history: (conversationId) => f.db.getRecentConvTurns(conversationId, 200, undefined, OUTWARD_ACP_SURFACE)
        .map((turn) => ({ role: turn.role as "user" | "assistant", text: turn.text })),
    };
    const restarted = executor(f.db, []);
    expect(restarted.status(f.repo.get("s1")!)).toMatchObject({
      state: "failed",
      lastRun: { status: "failed", error: expect.stringContaining("outward ACP") },
    });
    expect(f.sessions.history!("acp:c1")).toEqual([{ role: "user", text: "accepted before failure" }]);
  });

  it("does not replay an assistant answer when its terminal Run update fails", async () => {
    const f = fixture();
    const session = f.repo.create({ sessionId: "s1", conversationId: "acp:c1", cwd: f.root });
    const exec = executor(f.db, []);
    const app = createOutwardAcpAgent({ sessions: f.sessions, promptExecutor: exec, workstreams: exec });
    const updateRunCompleted = f.db.updateRunCompleted.bind(f.db);
    f.db.updateRunCompleted = () => false;
    try {
      await expect(acp.client({ name: "t" }).connectWith(app, (agent) =>
        agent.request(acp.methods.agent.session.prompt, { sessionId: "s1", prompt: [{ type: "text", text: "do not mark complete" }] })))
        .rejects.toMatchObject({ code: -32001 });
    } finally {
      f.db.updateRunCompleted = updateRunCompleted;
    }
    expect(f.sessions.history!(session.conversationId)).toEqual([{ role: "user", text: "do not mark complete" }]);
    expect(exec.status(session)).toMatchObject({ state: "failed", lastRun: { status: "failed" } });
  });
});
