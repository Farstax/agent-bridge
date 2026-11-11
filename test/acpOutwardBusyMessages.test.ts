import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { cleanupStaleOutwardAcpAttachments } from "../src/acpServer/attachments.js";
import { StdioRpc, waitFor } from "./support/stdioRpc.js";

// Issue #1130 slice 1: outward ACP shares Bridge's durable admission, queue,
// interrupt and recovery mechanics. Every scenario uses real stdio ACP
// connections to independent processes sharing one Bridge database.

const OPT_IN = { "agent-bridge/busy-messages": 1 };
let root: string;
let control: string;
let dbPath: string;
const clients: StdioRpc[] = [];

function agent(): StdioRpc {
  const client = new StdioRpc(dbPath, root, control);
  clients.push(client);
  return client;
}
const executions = (): Array<{ prompt: string; attachments: string[]; pid: number }> =>
  existsSync(join(control, "executions.log"))
    ? readFileSync(join(control, "executions.log"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
const release = (name: string) => writeFileSync(join(control, `release-${name}`), "");
const prompt = (client: StdioRpc, sessionId: string, text: string, meta: Record<string, unknown> = {}, extra: unknown[] = []) =>
  client.request("session/prompt", { sessionId, prompt: [{ type: "text", text }, ...extra], _meta: meta["agent-bridge/busy-messages"] === 1 && !meta["agent-bridge/request-id"] ? { ...meta, "agent-bridge/request-id": randomUUID() } : meta });
const status = async (client: StdioRpc, sessionId: string) =>
  (await client.request("_agent-bridge/workstreams/status", { sessionId, cwd: root })).result.status;
async function session(client: StdioRpc): Promise<string> {
  return (await client.request("session/new", { cwd: root, mcpServers: [] })).result.sessionId;
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "outward-busy-")));
  control = join(root, ".control");
  dbPath = join(root, "bridge.sqlite");
  openDb(dbPath, { databaseRole: "interactive" }).close();
  mkdirSync(control, { recursive: true });
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  rmSync(root, { recursive: true, force: true });
});

describe("outward ACP busy-message admission over real stdio", () => {
  it("advertises the extension and keeps non-opted-in clients on fail-fast busy", async () => {
    const a = agent();
    const init = await a.initialize();
    expect(init.result.agentCapabilities._meta["agent-bridge"].busyMessages).toBe(1);
    const sid = await session(a);
    const first = prompt(a, sid, "hold:one");
    await waitFor(() => executions().length === 1);

    const b = agent(); await b.initialize();
    const legacy = await prompt(b, sid, "second");
    expect(legacy.error.code).toBe(-32002);
    expect((await status(b, sid)).queued).toBe(0);
    release("one");
    expect((await first).result.stopReason).toBe("end_turn");
    expect(executions().map((e) => e.prompt)).toEqual(["hold:one"]);
  }, 60000);

  it("requires a stable request ID when a client opts into busy-message admission", async () => {
    const client = agent(); await client.initialize();
    const sid = await session(client);
    const result = await client.request("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "no stable identity" }], _meta: OPT_IN });
    expect(result.error.code).toBe(-32602);
    expect(result.error.message).toContain("requires a stable request ID");
  });

  it("queues from a second process, preserves order and runs each message exactly once", async () => {
    const a = agent(); await a.initialize();
    const sid = await session(a);
    const first = prompt(a, sid, "hold:one");
    await waitFor(() => executions().length === 1);

    const b = agent(); await b.initialize();
    const receipt = await prompt(b, sid, "hold:two", OPT_IN);
    expect(receipt.result._meta["agent-bridge"]).toMatchObject({ outcome: "queued", mode: "queue", position: 1 });
    expect(typeof receipt.result._meta["agent-bridge"].queueId).toBe("number");
    const submittedAt = "2026-09-21T10:11:12.123Z";
    const store = openDb(dbPath, { databaseRole: "interactive" });
    try {
      expect(store.raw.prepare("UPDATE pending_messages SET created_at = ? WHERE id = ?")
        .run(submittedAt, receipt.result._meta["agent-bridge"].queueId).changes).toBe(1);
    } finally { store.close(); }
    const third = await prompt(b, sid, "third", OPT_IN);
    expect(third.result._meta["agent-bridge"]).toMatchObject({ outcome: "queued", position: 2 });
    const live = await status(b, sid);
    expect(live).toMatchObject({ state: "running", queued: 2 });

    release("one");
    await first;
    await waitFor(() => executions().length === 2);
    expect((await status(b, sid)).queued).toBe(1);
    release("two");
    await waitFor(() => executions().length === 3);
    expect(executions().map((e) => e.prompt)).toEqual(["hold:one", "hold:two", "third"]);
    await waitFor(async () => (await status(b, sid)).queued === 0);
    expect(new Set(executions().map((e) => e.prompt)).size).toBe(3);
    const observed = openDb(dbPath, { databaseRole: "interactive" });
    try {
      const submitted = observed.raw.prepare("SELECT created_at AS time FROM conversation_turns WHERE role = 'user' AND text = ?")
        .get("hold:two") as { time: string } | undefined;
      const completed = observed.raw.prepare("SELECT created_at AS time FROM conversation_turns WHERE role = 'assistant' AND text = ?")
        .get("done:hold:two") as { time: string } | undefined;
      expect(submitted?.time).toBe(submittedAt);
      expect(completed?.time).toBeTruthy();
      expect(completed?.time).not.toBe(submittedAt);
    } finally { observed.close(); }
  }, 60000);

  it("retains the accepted-at time when an augment message is steered into an active Run", async () => {
    const a = agent(); await a.initialize();
    const sid = await session(a);
    const mode = await a.request("_agent-bridge/commands/run", {
      sessionId: sid, cwd: root, command: "queue_mode", select: "queue_mode:augment",
    });
    expect(mode.error).toBeUndefined();
    const first = prompt(a, sid, "hold:steer");
    await waitFor(() => executions().length === 1);
    const b = agent(); await b.initialize();
    // Steering requires the ACP process that owns the active provider Run.
    const augment = prompt(a, sid, "steered submission", {
      ...OPT_IN, "agent-bridge/request-id": "timestamp-steered-001",
    });
    await waitFor(() => existsSync(join(control, "steering.log")));
    const submittedAt = "2026-09-21T08:09:10.123Z";
    const store = openDb(dbPath, { databaseRole: "interactive" });
    try {
      expect(store.raw.prepare("UPDATE pending_messages SET created_at = ? WHERE prompt = ?")
        .run(submittedAt, "steered submission").changes).toBe(1);
    } finally { store.close(); }
    release("steering-rpc");
    const received = await augment;
    expect(received.result._meta["agent-bridge"].outcome).toBe("steered");
    release("steer");
    await first;
    const observed = openDb(dbPath, { databaseRole: "interactive" });
    try {
      const submitted = observed.raw.prepare("SELECT created_at AS time FROM conversation_turns WHERE role = 'user' AND text = ?")
        .get("steered submission") as { time: string } | undefined;
      expect(submitted?.time).toBe(submittedAt);
    } finally { observed.close(); }
  }, 60000);

  it("is idempotent for a repeated request id before and after settlement", async () => {
    const a = agent(); await a.initialize();
    const sid = await session(a);
    const first = prompt(a, sid, "hold:one");
    await waitFor(() => executions().length === 1);
    const b = agent(); await b.initialize();
    const meta = { ...OPT_IN, "agent-bridge/request-id": "client-req-1" };
    const one = await prompt(b, sid, "second", meta);
    const two = await prompt(b, sid, "second", meta);
    expect(two.result._meta["agent-bridge"].queueId).toBe(one.result._meta["agent-bridge"].queueId);
    expect((await status(b, sid)).queued).toBe(1);
    release("one"); await first;
    await waitFor(() => executions().length === 2);
    await waitFor(async () => (await status(b, sid)).queued === 0);
    const replay = await prompt(b, sid, "second", meta);
    expect(replay.result._meta["agent-bridge"]).toMatchObject({ outcome: "settled", status: "done" });
    expect(executions().map((e) => e.prompt)).toEqual(["hold:one", "second"]);
  }, 60000);

  it("atomically admits one of two concurrent copies of the same request ID and attachment", async () => {
    const a = agent(); await a.initialize();
    const sid = await session(a);
    const first = prompt(a, sid, "hold:one");
    await waitFor(() => executions().length === 1);
    const b = agent(); const c = agent();
    await Promise.all([b.initialize(), c.initialize()]);
    const meta = { ...OPT_IN, "agent-bridge/request-id": "raced-request" };
    const attachment = (text: string) => ({ type: "resource", resource: { uri: "file:///note.txt", mimeType: "text/plain", text } });
    const [left, right] = await Promise.all([
      prompt(b, sid, "same request", meta, [attachment("left body")]),
      prompt(c, sid, "same request", meta, [attachment("right body")]),
    ]);
    expect([left.error, right.error]).toEqual([undefined, undefined]);
    expect(left).toMatchObject({ result: { _meta: { "agent-bridge": { outcome: "queued" } } } });
    expect(right).toMatchObject({ result: { _meta: { "agent-bridge": { outcome: "queued" } } } });
    expect(left.result._meta["agent-bridge"].queueId).toBe(right.result._meta["agent-bridge"].queueId);
    expect((await status(b, sid)).queued).toBe(1);
    await Promise.all([b.close(), c.close()]);
    release("one"); await first;
    await waitFor(() => executions().length === 2);
    expect(executions().filter((entry) => entry.prompt.startsWith("same request"))).toHaveLength(1);
    expect(executions()[1].attachments).toHaveLength(1);
    expect(["left body", "right body"]).toContain(executions()[1].attachments[0]);
  }, 60000);

  it("does not queue a duplicate request that races the first direct Run", async () => {
    const a = agent(); const b = agent();
    await Promise.all([a.initialize(), b.initialize()]);
    const sid = await session(a);
    const meta = { ...OPT_IN, "agent-bridge/request-id": "direct-race" };
    let early: Awaited<ReturnType<typeof prompt>> | undefined;
    const first = prompt(a, sid, "hold:one", meta).then((value) => { early ??= value; return value; });
    const second = prompt(b, sid, "hold:two", meta).then((value) => { early ??= value; return value; });
    await waitFor(() => early !== undefined);
    expect(early).toMatchObject({ result: { _meta: { "agent-bridge": { outcome: "running" } } } });
    await waitFor(() => executions().length === 1);
    expect(executions()).toHaveLength(1);
    expect((await status(b, sid)).queued).toBe(0);
    release("one"); release("two");
    await Promise.all([first, second]);
    expect(executions()).toHaveLength(1);
  }, 60000);


  it("never acknowledges an abandoned direct reservation as a running Run", async () => {
    const a = agent(); const b = agent();
    await Promise.all([a.initialize(), b.initialize()]);
    const sid = await session(a);
    const requestId = "owner-abandoned-before-run";
    const key = `acp-request:${sid}:${requestId}`;
    const owner = openDb(dbPath, { serviceId: "acp:fixture-reservation-owner", databaseRole: "interactive" });
    try {
      const row = owner.raw.prepare("SELECT conversation_id AS id FROM outward_acp_sessions WHERE session_id = ?")
        .get(sid) as { id: string };
      const lane = owner.acquireLaneForIdempotentRequest(
        "acp:outward", row.id, key,
        `outward-queue-reservation:${key}`,
        `outward-queue-receipt:${key}`,
        `outward-queue-run:${key}`,
        "fixture-owner-token",
      );
      expect(lane).not.toBeNull();
      const attempt = prompt(b, sid, "hold:abandoned", { ...OPT_IN, "agent-bridge/request-id": requestId });
      // The owner has not persisted a Run; a transient reservation is not
      // a completed ACP receipt. It must not falsely claim "running".
      let responded = false;
      void attempt.then(() => { responded = true; });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(responded).toBe(false);
      expect(executions()).toHaveLength(0);
      expect(owner.unlock(lane!)).toBe(true);
      // The outstanding idempotent request can safely claim the abandoned
      // reservation because no Run link or receipt was ever committed.
      await waitFor(() => executions().length === 1);
      release("abandoned");
      expect((await attempt).result.stopReason).toBe("end_turn");
      expect(executions()).toHaveLength(1);
      expect(owner.getPendingMessageIdByCorrelationKey("acp:outward", key)).toBeNull();
    } finally {
      owner.close();
    }
  }, 60000);

  it("recovers an expired reservation only after its direct owner is proven absent", async () => {
    const b = agent(); await b.initialize();
    const sid = await session(b);
    const requestId = "stale-owner-before-run";
    const key = `acp-request:${sid}:${requestId}`;
    // Model a deceased ACP stdio owner after initialization, so the same
    // already-connected client must perform recovery on its prompt path.
    const owner = openDb(dbPath, { serviceId: "acp:outward/2147483647/0", databaseRole: "interactive" });
    try {
      const row = owner.raw.prepare("SELECT conversation_id AS id FROM outward_acp_sessions WHERE session_id = ?")
        .get(sid) as { id: string };
      const lane = owner.acquireLaneForIdempotentRequest(
        "acp:outward", row.id, key,
        `outward-queue-reservation:${key}`,
        `outward-queue-receipt:${key}`,
        `outward-queue-run:${key}`,
        "dead-owner-token",
      );
      expect(lane).not.toBeNull();
      owner.raw.prepare("UPDATE execution_locks SET lease_expires_at = ? WHERE acquisition_id = ?")
        .run("2000-01-01T00:00:00.000Z", lane!.acquisitionId);

      const submitted = prompt(b, sid, "hold:stale", { ...OPT_IN, "agent-bridge/request-id": requestId });
      await waitFor(() => executions().length === 1);
      release("stale");
      const outcome = await submitted;
      expect(outcome.error).toBeUndefined();
      expect(executions()).toHaveLength(1);
      expect(owner.getSetting(`outward-queue-reservation:${key}`)).toBeNull();
      expect(owner.getPendingMessageIdByCorrelationKey("acp:outward", key)).toBeNull();
      const audits = owner.raw.prepare(
        "SELECT status FROM reconciliation_audit WHERE kind = 'lock' AND reason = 'outward_acp_service_restart'",
      ).all() as Array<{ status: string }>;
      expect(audits.some((audit) => audit.status === "completed")).toBe(true);
    } finally {
      owner.close();
    }
  }, 60000);

  it("keeps exactly one direct Run across repeated simultaneous request-ID submissions", async () => {
    const a = agent(); const b = agent();
    await Promise.all([a.initialize(), b.initialize()]);
    for (let index = 0; index < 16; index += 1) {
      const sid = await session(a);
      const name = `repeated-${index}`;
      const meta = { ...OPT_IN, "agent-bridge/request-id": `same-direct-${index}` };
      let early: Awaited<ReturnType<typeof prompt>> | undefined;
      const first = prompt(a, sid, `hold:${name}`, meta).then((value) => { early ??= value; return value; });
      const second = prompt(b, sid, `hold:${name}`, meta).then((value) => { early ??= value; return value; });
      await waitFor(() => early !== undefined);
      if (early?.result?._meta?.["agent-bridge"]?.outcome !== "running") {
        // CI-only failure evidence: the sender can receive an ACP error, not
        // merely a misleading receipt. Capture the authoritative shared state.
        const probe = openDb(dbPath, { serviceId: "acp:race-diagnostic", databaseRole: "interactive" });
        let snapshot: unknown;
        try {
          const row = probe.raw.prepare("SELECT conversation_id AS id FROM outward_acp_sessions WHERE session_id = ?")
            .get(sid) as { id: string };
          const key = `acp-request:${sid}:same-direct-${index}`;
          snapshot = {
            lock: probe.raw.prepare("SELECT surface, chat_key, service_id, run_id, acquisition_id FROM execution_locks WHERE chat_key = ?").all(row.id),
            pending: probe.raw.prepare("SELECT id, state, scheduled_occurrence_key FROM pending_messages WHERE chat_key = ?").all(row.id),
            latest: probe.getLatestRunForConversation({ surfaceIdentity: "acp:outward", chatKey: row.id }),
            failedRun: early?.error?.data?.runId ? probe.getRun(early.error.data.runId) : null,
            allRuns: probe.raw.prepare("SELECT run_id, status, error, started_at, ended_at FROM bridge_runs WHERE chat_id = ? ORDER BY started_at").all(row.id),
            reservation: probe.getSetting(`outward-queue-reservation:${key}`),
            link: probe.getSetting(`outward-queue-run:${key}`),
            receipt: probe.getSetting(`outward-queue-receipt:${key}`),
          };
        } finally {
          probe.close();
        }
        throw new Error(`direct race iteration ${index}: ${JSON.stringify({
          early, snapshot, aStderr: a.stderr.slice(-1200), bStderr: b.stderr.slice(-1200),
        })}`);
      }
      await waitFor(() => executions().length === index + 1);
      expect(executions()).toHaveLength(index + 1);
      expect((await status(b, sid)).queued).toBe(0);
      release(name);
      await Promise.all([first, second]);
      // A running receipt acknowledges admission, not provider completion.
      // Finish this round before opening another independent Workstream so
      // the test isolates the same-ID race instead of accumulating live Runs.
      await waitFor(async () => (await status(b, sid)).state === "idle");
      expect(executions()).toHaveLength(index + 1);
    }
  }, 120000);

  it("rejects admission when the durable queue is full", async () => {
    const a = agent(); await a.initialize();
    const sid = await session(a);
    void prompt(a, sid, "hold:one");
    await waitFor(() => executions().length === 1);
    const b = agent(); await b.initialize();
    for (let index = 0; index < 5; index += 1) {
      expect((await prompt(b, sid, `q${index}`, OPT_IN)).result._meta["agent-bridge"].outcome).toBe("queued");
    }
    const refused = await prompt(b, sid, "overflow", OPT_IN);
    expect(refused.error.code).toBe(-32002);
    expect((await status(b, sid)).queued).toBe(5);
  }, 60000);

  it("interrupt mode stops the active Run in another process and runs the new message", async () => {
    const a = agent(); await a.initialize();
    const sid = await session(a);
    const first = prompt(a, sid, "hold:one");
    await waitFor(() => executions().length === 1);
    const b = agent(); await b.initialize();
    const set = await b.request("_agent-bridge/commands/run", { sessionId: sid, cwd: root, command: "queue_mode", select: "queue_mode:interrupt" });
    expect(set.result.text).toContain("Busy-message mode: interrupt");
    const receipt = await prompt(b, sid, "urgent", OPT_IN);
    expect(["queued", "running", "settled"]).toContain(receipt.result._meta["agent-bridge"].outcome);
    expect((await first).result.stopReason).toBe("cancelled");
    await waitFor(() => executions().some((e) => e.prompt === "urgent"));
    expect(executions().filter((e) => e.prompt === "hold:one")).toHaveLength(1);
  }, 60000);

  it("Stop during an interrupt cancels the replacement Run and queued follow-up", async () => {
    const a = agent(); await a.initialize();
    const sid = await session(a);
    const first = prompt(a, sid, "hold:first");
    await waitFor(() => executions().length === 1);
    const b = agent(); await b.initialize();
    await b.request("_agent-bridge/commands/run", { sessionId: sid, cwd: root, command: "queue_mode", select: "queue_mode:interrupt" });
    const replacement = prompt(b, sid, "hold:replacement", OPT_IN);
    await waitFor(() => executions().length === 2);
    expect((await first).result.stopReason).toBe("cancelled");
    expect((await status(b, sid)).state).toBe("running");

    await b.request("_agent-bridge/commands/run", { sessionId: sid, cwd: root, command: "queue_mode", select: "queue_mode:queue" });
    const c = agent(); await c.initialize();
    const requestId = "stop-during-interrupt-followup";
    expect((await prompt(c, sid, "queued after interrupt", { ...OPT_IN, "agent-bridge/request-id": requestId })).result._meta["agent-bridge"].outcome).toBe("queued");
    const stopped = await c.request("_agent-bridge/commands/run", { sessionId: sid, cwd: root, command: "stop" });
    expect(stopped.result.stop).toBe("confirmed");
    await replacement;
    expect((await status(c, sid)).state).toBe("cancelled");
    const retry = await prompt(c, sid, "queued after interrupt", { ...OPT_IN, "agent-bridge/request-id": requestId });
    expect(retry.result._meta["agent-bridge"]).toMatchObject({ outcome: "settled", status: "cancelled" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(executions().map((run) => run.prompt)).toEqual(["hold:first", "hold:replacement"]);
  }, 60000);

  it("Stop from a second process genuinely cancels the owning process's Run", async () => {
    const a = agent(); await a.initialize();
    const sid = await session(a);
    const first = prompt(a, sid, "hold:one");
    await waitFor(() => executions().length === 1);
    const b = agent(); await b.initialize();
    expect((await prompt(b, sid, "accepted before cancel", OPT_IN)).result._meta["agent-bridge"].outcome).toBe("queued");
    b.notify("session/cancel", { sessionId: sid });
    expect((await first).result.stopReason).toBe("cancelled");
    // Standard ACP request cancellation targets the active request only; an
    // explicitly accepted busy-message remains valid work and must run.
    await waitFor(() => executions().length === 2);
    expect(executions().map((run) => run.prompt)).toEqual(["hold:one", "accepted before cancel"]);
    // A later user-facing Stop with nothing running is a harmless no-op.
    const stop = await b.request("_agent-bridge/commands/run", { sessionId: sid, cwd: root, command: "stop" });
    expect(stop.result.command).toBe("stop");
    expect(executions()).toHaveLength(2);
  }, 60000);

  it("confirmed Stop discards queued prompts and attachments across ACP processes", async () => {
    const a = agent(); await a.initialize();
    const sid = await session(a);
    const first = prompt(a, sid, "hold:stop-target");
    await waitFor(() => executions().length === 1);

    const b = agent(); await b.initialize();
    const requestId = "queued-before-stop";
    const file = { type: "resource", resource: { uri: "file:///stop.txt", mimeType: "text/plain", text: "must be discarded" } };
    expect((await prompt(b, sid, "discarded queue item", { ...OPT_IN, "agent-bridge/request-id": requestId }, [file])).result._meta["agent-bridge"].outcome).toBe("queued");
    expect(readdirSync(root).some((name) => name.startsWith(".agent-bridge-queued-attachments-"))).toBe(true);
    const queuedHistory = (await b.request("_agent-bridge/workstreams/history_page", { sessionId: sid, cwd: root })).result.messages;
    expect(queuedHistory).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: `user-${requestId}`, text: expect.stringContaining("discarded queue item"), state: "pending" }),
    ]));

    const c = agent(); await c.initialize();
    const stopped = await c.request("_agent-bridge/commands/run", { sessionId: sid, cwd: root, command: "stop" });
    expect(stopped.result.stop).toBe("confirmed");
    expect((await first).result.stopReason).toBe("cancelled");
    expect((await status(c, sid)).queued).toBe(0);
    expect(readdirSync(root).some((name) => name.startsWith(".agent-bridge-queued-attachments-"))).toBe(false);
    const cancelledHistory = (await c.request("_agent-bridge/workstreams/history_page", { sessionId: sid, cwd: root })).result.messages;
    expect(cancelledHistory).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: `user-${requestId}`, text: expect.stringContaining("discarded queue item"), state: "cancelled" }),
    ]));
    const isolated = await session(c);
    const otherHistory = (await c.request("_agent-bridge/workstreams/history_page", { sessionId: isolated, cwd: root })).result.messages;
    expect(otherHistory.some((item: { text: string }) => item.text === "discarded queue item")).toBe(false);

    const retry = await prompt(c, sid, "discarded queue item", { ...OPT_IN, "agent-bridge/request-id": requestId }, [file]);
    expect(retry.result._meta["agent-bridge"]).toMatchObject({ outcome: "settled", status: "cancelled" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(executions().map((run) => run.prompt)).toEqual(["hold:stop-target"]);

    expect((await prompt(c, sid, "after confirmed stop")).result.stopReason).toBe("end_turn");
    expect(executions().map((run) => run.prompt)).toEqual(["hold:stop-target", "after confirmed stop"]);
    expect((await c.request("_agent-bridge/workstreams/history_page", { sessionId: sid, cwd: root })).result.messages)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: `user-${requestId}`, state: "cancelled" })]));
  }, 60000);

  it("keeps a claimed attachment until its active Run is cancelled, then releases it", async () => {
    const a = agent(); await a.initialize();
    const sid = await session(a);
    const first = prompt(a, sid, "hold:first");
    await waitFor(() => executions().length === 1);

    const b = agent(); await b.initialize();
    const requestId = "claimed-attachment-stop";
    const file = { type: "resource", resource: { uri: "file:///claimed.txt", mimeType: "text/plain", text: "active attachment" } };
    expect((await prompt(b, sid, "hold:second", { ...OPT_IN, "agent-bridge/request-id": requestId }, [file])).result._meta["agent-bridge"].outcome).toBe("queued");
    release("first");
    expect((await first).result.stopReason).toBe("end_turn");
    await waitFor(() => executions().length === 2);
    const retained = readdirSync(root).filter((name) => name.startsWith(".agent-bridge-queued-attachments-"));
    expect(retained).toHaveLength(1);

    const c = agent(); await c.initialize();
    const stopped = await c.request("_agent-bridge/commands/run", { sessionId: sid, cwd: root, command: "stop" });
    expect(stopped.result.stop).toBe("confirmed");
    expect((await status(c, sid)).queued).toBe(0);
    await waitFor(() => readdirSync(root).every((name) => !name.startsWith(".agent-bridge-queued-attachments-")));
    const retry = await prompt(c, sid, "hold:second", { ...OPT_IN, "agent-bridge/request-id": requestId }, [file]);
    expect(retry.result._meta["agent-bridge"]).toMatchObject({ outcome: "settled", status: "cancelled" });
    expect(executions().map((run) => run.prompt)).toHaveLength(2);
    expect(executions()[1]?.prompt).toContain("hold:second");
    expect(executions()[1]?.prompt).toContain("[Attached file: 01-claimed.txt]");
  }, 60000);

  it("retains queued attachments across the submitting connection and releases them after execution", async () => {
    const a = agent(); await a.initialize();
    const sid = await session(a);
    const first = prompt(a, sid, "hold:one");
    await waitFor(() => executions().length === 1);
    const b = agent(); await b.initialize();
    const file = { type: "resource", resource: { uri: "file:///note.txt", mimeType: "text/plain", text: "queued attachment body" } };
    const receipt = await prompt(b, sid, "with file", OPT_IN, [file]);
    expect(receipt.result._meta["agent-bridge"].outcome).toBe("queued");
    await b.close(); // the submitting connection ends before execution
    const retained = readdirSync(root).filter((name) => name.startsWith(".agent-bridge-queued-attachments-"));
    expect(retained.length).toBeGreaterThan(0);
    const retainedPath = join(root, retained[0]);
    utimesSync(retainedPath, new Date(0), new Date(0));
    await cleanupStaleOutwardAcpAttachments(root, [], Date.now() + 10 * 24 * 60 * 60 * 1000);
    expect(existsSync(retainedPath)).toBe(true);

    release("one"); await first;
    await waitFor(() => executions().length === 2);
    expect(executions()[1].attachments).toEqual(["queued attachment body"]);
    await waitFor(() => !existsSync(retainedPath));
  }, 60000);

  it("does not replay a prompt whose execution may have started after the owner dies", async () => {
    const a = agent(); await a.initialize();
    const sid = await session(a);
    void prompt(a, sid, "hold:one");
    await waitFor(() => executions().length === 1);
    const b = agent(); await b.initialize();
    expect((await prompt(b, sid, "after crash", OPT_IN)).result._meta["agent-bridge"].outcome).toBe("queued");
    await a.kill("SIGKILL");

    // A fresh process recovers the stale lane on its next submission and then
    // drains in order; the interrupted prompt is never executed a second time.
    const c = agent(); await c.initialize();
    const receipt = await prompt(c, sid, "fresh", OPT_IN);
    expect(["queued", "settled"]).toContain(receipt.result._meta["agent-bridge"].outcome);
    await waitFor(() => executions().map((e) => e.prompt).includes("fresh"), 30000);
    const ran = executions().map((e) => e.prompt);
    expect(ran.filter((p) => p === "hold:one")).toHaveLength(1);
    expect(ran.filter((p) => p === "after crash")).toHaveLength(1);
    expect(ran.indexOf("after crash")).toBeLessThan(ran.indexOf("fresh"));
  }, 90000);
  it("keeps a remote Stop authoritative over a held injected steer from another real ACP process", async () => {
    const a = agent(); await a.initialize();
    const sid = await session(a);
    await a.request("_agent-bridge/commands/run", {
      sessionId: sid, cwd: root, command: "queue_mode", select: "queue_mode:augment",
    });
    const first = prompt(a, sid, "hold:steer");
    await waitFor(() => executions().length === 1);
    const requestId = "held-steering-remote-stop";
    const followup = prompt(a, sid, "injected-after-stop", {
      ...OPT_IN, "agent-bridge/request-id": requestId,
    });
    await waitFor(() => existsSync(join(control, "steering.log")));
    expect(readFileSync(join(control, "steering.log"), "utf8")).toContain("injected-after-stop");

    const b = agent(); await b.initialize();
    const stop = await b.request("_agent-bridge/commands/run", { sessionId: sid, cwd: root, command: "stop" });
    expect(stop.result.stop).toBe("confirmed");
    expect((await first).result.stopReason).toBe("cancelled");

    release("steering-rpc");
    const receipt = await followup;
    expect(receipt.result._meta["agent-bridge"]).toMatchObject({ outcome: "settled", status: "cancelled" });
    const replay = await prompt(b, sid, "injected-after-stop", {
      ...OPT_IN, "agent-bridge/request-id": requestId,
    });
    expect(replay.result._meta["agent-bridge"]).toMatchObject({ outcome: "settled", status: "cancelled" });
    expect((await status(b, sid)).queued).toBe(0);
    expect(executions().map((run) => run.prompt)).toEqual(["hold:steer"]);
  }, 60000);

});
