import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
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
  client.request("session/prompt", { sessionId, prompt: [{ type: "text", text }, ...extra], _meta: meta });
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

  it("queues from a second process, preserves order and runs each message exactly once", async () => {
    const a = agent(); await a.initialize();
    const sid = await session(a);
    const first = prompt(a, sid, "hold:one");
    await waitFor(() => executions().length === 1);

    const b = agent(); await b.initialize();
    const receipt = await prompt(b, sid, "second", OPT_IN);
    expect(receipt.result._meta["agent-bridge"]).toMatchObject({ outcome: "queued", mode: "queue", position: 1 });
    expect(typeof receipt.result._meta["agent-bridge"].queueId).toBe("number");
    const third = await prompt(b, sid, "third", OPT_IN);
    expect(third.result._meta["agent-bridge"]).toMatchObject({ outcome: "queued", position: 2 });
    const live = await status(b, sid);
    expect(live).toMatchObject({ state: "running", queued: 2 });

    release("one");
    await first;
    await waitFor(() => executions().length === 3);
    expect(executions().map((e) => e.prompt)).toEqual(["hold:one", "second", "third"]);
    await waitFor(async () => (await status(b, sid)).queued === 0);
    expect(new Set(executions().map((e) => e.prompt)).size).toBe(3);
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
    expect(executions()).toHaveLength(1);
    expect(early).toMatchObject({ result: { _meta: { "agent-bridge": { outcome: "running" } } } });
    expect((await status(b, sid)).queued).toBe(0);
    release("one"); release("two");
    await Promise.all([first, second]);
    expect(executions()).toHaveLength(1);
  }, 60000);

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
    expect(receipt.result._meta["agent-bridge"].outcome).toBe("queued");
    expect((await first).result.stopReason).toBe("cancelled");
    await waitFor(() => executions().some((e) => e.prompt === "urgent"));
    expect(executions().filter((e) => e.prompt === "hold:one")).toHaveLength(1);
  }, 60000);

  it("Stop from a second process genuinely cancels the owning process's Run", async () => {
    const a = agent(); await a.initialize();
    const sid = await session(a);
    const first = prompt(a, sid, "hold:one");
    await waitFor(() => executions().length === 1);
    const b = agent(); await b.initialize();
    b.notify("session/cancel", { sessionId: sid });
    expect((await first).result.stopReason).toBe("cancelled");
    await waitFor(async () => (await status(b, sid)).state === "cancelled");
    // A late Stop with nothing running is a harmless no-op.
    const stop = await b.request("_agent-bridge/commands/run", { sessionId: sid, cwd: root, command: "stop" });
    expect(stop.result.command).toBe("stop");
    expect(executions()).toHaveLength(1);
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
    const retained = readdirSync(root).filter((name) => name.startsWith(".agent-bridge-attachments-wait-") && !name.includes("-tmp-"));
    expect(retained.length).toBeGreaterThan(0);

    release("one"); await first;
    await waitFor(() => executions().length === 2);
    expect(executions()[1].attachments).toEqual(["queued attachment body"]);
    await waitFor(() => readdirSync(root).filter((name) => name.startsWith(".agent-bridge-attachments-wait-") && !name.includes("-tmp-")).length === 0);
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
});
