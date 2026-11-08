import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { type as eventType } from "../src/events/types.js";
import { OutwardAcpSessionRepository } from "../src/repositories/outwardAcpSessionRepository.js";
import { AcpCommands } from "../src/acpServer/commands.js";
import { BridgeOutwardAcpPromptExecutor, OUTWARD_ACP_SURFACE } from "../src/acpServer/execution.js";
import { recoverOutwardLanes } from "../src/acpServer/recovery.js";
import { executionLaneCoordinator } from "../src/executionLaneCoordinator.js";
import { outwardCommandConfig } from "../src/acpServer/execution.js";

// Issue #1130 correction: Stop distinguishes "requested" from "confirmed".

function fixture(stopWaitMs = 400) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "outward-stop-")));
  const dbPath = join(root, "bridge.sqlite");
  const db = openDb(dbPath, { databaseRole: "interactive", serviceId: "acp:outward/owner" });
  const observer = openDb(dbPath, { databaseRole: "interactive", serviceId: "acp:outward/observer" });
  const sessions = new OutwardAcpSessionRepository(db.raw);
  const session = sessions.create({ sessionId: "s1", conversationId: "acp:c1", cwd: root });
  const lane = JSON.stringify([OUTWARD_ACP_SURFACE, session.conversationId]);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const make = (target: typeof db, responsive: boolean) => new BridgeOutwardAcpPromptExecutor({
    db: target, providerChain: ["codex"] as const, remoteStopWaitMs: stopWaitMs,
    createEngine: () => ({
      executeSurfaceNeutralTurn: async (input) => {
        input.collect(eventType.runStarted({ runId: input.runId, bot: "codex", chatId: String(input.chatId), chatKey: input.chatKey, command: "fake", cwd: root, model: null }));
        const coordinator = executionLaneCoordinator(target, OUTWARD_ACP_SURFACE);
        // An unresponsive provider never observes the abort and never ends on its own.
        if (!responsive) await gate; // never observes the abort
        else while (!coordinator.isAborted(lane)) await Promise.race([gate, new Promise((resolve) => setTimeout(resolve, 20))]);
        return { text: "", sessionId: "p", stopReason: responsive ? "cancelled" : "end_turn" };
      },
    }),
  });
  const prompt = (executor: BridgeOutwardAcpPromptExecutor) => executor.execute({
    session, prompt: "work", signal: new AbortController().signal, onUpdate: () => undefined,
  });
  return { root, db, observer, session, make, prompt, release: () => release(),
    cleanup: () => { release(); db.close(); observer.close(); rmSync(root, { recursive: true, force: true }); } };
}
const running = (f: ReturnType<typeof fixture>) => f.db.listRunningRuns(OUTWARD_ACP_SURFACE);
const wait = async (read: () => boolean) => { for (let i = 0; i < 300 && !read(); i += 1) await new Promise((r) => setTimeout(r, 20)); expect(read()).toBe(true); };

describe("outward ACP Stop confirmation", () => {
  it("confirms only after a responsive remote owner durably ends the Run", async () => {
    const f = fixture(5000);
    try {
      const owner = f.make(f.db, true);
      const first = f.prompt(owner);
      await wait(() => running(f).length === 1);
      const remote = f.make(f.observer, true);
      expect(await remote.cancel(f.session)).toBe("confirmed");
      await first;
      expect(running(f)).toHaveLength(0);
      expect(f.db.getRun(f.db.getLatestRunForConversation({ surfaceIdentity: OUTWARD_ACP_SURFACE, chatKey: f.session.conversationId })!.run_id)?.status).toBe("cancelled");
    } finally { f.cleanup(); }
  });

  it("stays pending for an unresponsive owner and neither releases the lane nor replays work", async () => {
    const f = fixture(300);
    try {
      const owner = f.make(f.db, false);
      const first = f.prompt(owner);
      await wait(() => running(f).length === 1);
      const runId = running(f)[0].run_id;
      const remote = f.make(f.observer, true);
      expect(await remote.cancel(f.session)).toBe("pending");
      // Still executing: Run is running, the lane is still owned, no second Run exists.
      expect(f.db.getRun(runId)?.status).toBe("running");
      expect(f.observer.acquireLock(OUTWARD_ACP_SURFACE, f.session.conversationId, false)).toBeNull();
      expect(running(f)).toHaveLength(1);
      expect(f.db.getSetting(`outward-cancel:${runId}`)).toBeTruthy();
      // A second Stop is equally unconfirmed, never success.
      expect(await remote.cancel(f.session)).toBe("pending");
      f.release();
      await first;
    } finally { f.cleanup(); }
  });

  it("returns pending promptly for a local owner whose provider ignores cancellation", async () => {
    const f = fixture(150);
    try {
      const owner = f.make(f.db, false);
      const first = f.prompt(owner);
      await wait(() => running(f).length === 1);
      const start = Date.now();
      expect(await owner.cancel(f.session)).toBe("pending");
      expect(Date.now() - start).toBeLessThan(2_000);
      expect(running(f)).toHaveLength(1);
      expect(f.db.getSetting(`outward-stop-fence:${f.session.conversationId}`)).toBeTruthy();
      f.release();
      await first;
    } finally { f.cleanup(); }
  });

  it("stays pending after the owner disconnects until proven-containment recovery ends the Run", async () => {
    const f = fixture(200);
    try {
      // A Run whose owner process is gone: durable `running` Run plus an expired lease.
      const dead = openDb(join(f.root, "bridge.sqlite"), { databaseRole: "interactive", serviceId: "acp:outward/4194300/1", lockLeaseMs: 1 });
      const lane = dead.acquireLock(OUTWARD_ACP_SURFACE, f.session.conversationId, false)!;
      dead.insertRun("orphan-run", { surfaceIdentity: OUTWARD_ACP_SURFACE, chatKey: f.session.conversationId }, "codex");
      dead.close();
      void lane;
      await new Promise((resolve) => setTimeout(resolve, 20));
      const remote = f.make(f.observer, true);
      expect(await remote.cancel(f.session)).toBe("pending");
      expect(f.db.getRun("orphan-run")?.status).toBe("running");
      await recoverOutwardLanes(f.db);
      expect(f.db.getRun("orphan-run")?.status).toBe("failed");
      expect(await remote.cancel(f.session)).toBe("confirmed");
    } finally { f.cleanup(); }
  });

  it("confirms immediately when the Run already ended and records no stop request", async () => {
    const f = fixture(200);
    try {
      const owner = f.make(f.db, true);
      const done = f.make(f.db, false);
      f.release();
      await f.prompt(done);
      expect(await owner.cancel(f.session)).toBe("confirmed");
      expect(f.db.raw.prepare("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'outward-cancel:%'").get()).toEqual({ n: 0 });
    } finally { f.cleanup(); }
  });

  it("/stop reports the unconfirmed state instead of success and /reset refuses to proceed", async () => {
    const f = fixture(150);
    try {
      const owner = f.make(f.db, false);
      const first = f.prompt(owner);
      await wait(() => running(f).length === 1);
      const remote = f.make(f.observer, true);
      const commands = new AcpCommands({ db: f.observer, config: outwardCommandConfig(join(f.root, "bridge.sqlite"), { INTERACTIVE_CLI_CHAIN: "codex" } as NodeJS.ProcessEnv), control: remote });
      const stop = await commands.run(f.session, { command: "stop" });
      expect(stop.stop).toBe("pending");
      expect(stop.text).toContain("not yet confirmed");
      expect(stop.text).not.toMatch(/was cancelled|confirmed\. No/);
      await expect(commands.run(f.session, { command: "reset", confirm: true })).rejects.toMatchObject({ code: -32002 });
      f.release();
      await first;
      const after = await commands.run(f.session, { command: "stop" });
      expect(after).toMatchObject({ stop: "confirmed" });
      expect(after.text).toContain("Stop confirmed");
    } finally { f.cleanup(); }
  });
});

describe("outward ACP Stop queue ownership", () => {
  it("fences new admission while cancellation is pending", async () => {
    const f = fixture(120);
    try {
      const owner = f.make(f.db, false);
      const first = f.prompt(owner);
      await wait(() => running(f).length === 1);
      const stopper = f.make(f.observer, true);
      expect(await stopper.cancel(f.session)).toBe("pending");
      await expect(stopper.execute({ session: f.session, prompt: "after stop", signal: new AbortController().signal, onUpdate: () => undefined }))
        .rejects.toMatchObject({ code: -32002 });
      f.release();
      await first;
    } finally { f.cleanup(); }
  });

  it("keeps orphaned Runs fenced until restart recovery proves containment", async () => {
    const f = fixture(120);
    try {
      const dead = openDb(join(f.root, "bridge.sqlite"), { databaseRole: "interactive", serviceId: "acp:outward/4194300/1", lockLeaseMs: 1 });
      dead.acquireLock(OUTWARD_ACP_SURFACE, f.session.conversationId, false);
      dead.insertRun("orphan-run", { surfaceIdentity: OUTWARD_ACP_SURFACE, chatKey: f.session.conversationId }, "codex");
      dead.admitMessage(OUTWARD_ACP_SURFACE, f.session.conversationId, { prompt: "accepted", chatId: "s1", chatType: "acp", scheduledOccurrenceKey: "acp-queue:dead" }, 5, true);
      dead.close();
      const stopper = f.make(f.observer, true);
      expect(await stopper.cancel(f.session)).toBe("pending");
      expect(f.db.dequeueMsgs(OUTWARD_ACP_SURFACE, f.session.conversationId)).toHaveLength(0);
      await recoverOutwardLanes(f.db);
      expect(f.db.getRun("orphan-run")?.status).toBe("failed");
      stopper.reconcileStopFences();
      expect(await stopper.cancel(f.session)).toBe("confirmed");
    } finally { f.cleanup(); }
  });
});
