import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { executionLaneCoordinator } from "../src/executionLaneCoordinator.js";
import { type as eventType } from "../src/events/types.js";
import { setLaneBusyMessageMode } from "../src/busyMessageMode.js";
import { listRunContinuations } from "../src/runContinuation.js";
import { OutwardAcpSessionRepository } from "../src/repositories/outwardAcpSessionRepository.js";
import { BridgeOutwardAcpPromptExecutor, OUTWARD_ACP_SURFACE } from "../src/acpServer/execution.js";

// Issue #1130: durable queue drained by a supervised owner, and augment steering.

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "outward-queue-drain-")));
  const db = openDb(join(root, "bridge.sqlite"), { databaseRole: "interactive" });
  const sessions = new OutwardAcpSessionRepository(db.raw);
  const session = sessions.create({ sessionId: "s1", conversationId: "acp:c1", cwd: root });
  const ran: string[] = [];
  let gate: Promise<void> = Promise.resolve();
  const executor = new BridgeOutwardAcpPromptExecutor({
    db,
    providerChain: ["codex"] as const,
    lookupSession: (id) => sessions.get(id),
    createEngine: () => ({
      executeSurfaceNeutralTurn: async (input) => {
        ran.push(input.prompt);
        input.collect(eventType.runStarted({ runId: input.runId, bot: "codex", chatId: String(input.chatId), chatKey: input.chatKey, command: "fake", cwd: root, model: null }));
        await gate;
        input.collect(eventType.runCompleted({ runId: input.runId, bot: "codex", chatId: String(input.chatId), chatKey: input.chatKey, text: "ok", sessionId: "p" }));
        return { text: "ok", sessionId: "p", stopReason: "end_turn" };
      },
    }),
  });
  return { root, db, session, executor, ran, hold: (promise: Promise<void>) => { gate = promise; },
    cleanup: () => { db.close(); rmSync(root, { recursive: true, force: true }); } };
}
const base = (session: ReturnType<typeof fixture>["session"], prompt: string, extra = {}) => ({
  session, prompt, signal: new AbortController().signal, onUpdate: () => undefined, ...extra,
});

describe("outward ACP durable queue ownership", () => {
  it("a supervised owner drains accepted work with no connected client", async () => {
    const f = fixture();
    try {
      f.db.admitMessage(OUTWARD_ACP_SURFACE, f.session.conversationId, {
        prompt: "accepted earlier", chatId: f.session.sessionId, chatType: "acp", scheduledOccurrenceKey: "acp-queue:k1",
      }, 5, true);
      expect(f.db.pendingMsgCount(OUTWARD_ACP_SURFACE, f.session.conversationId)).toBe(1);
      await f.executor.drainAllQueued();
      expect(f.ran).toEqual(["accepted earlier"]);
      expect(f.db.pendingMsgCount(OUTWARD_ACP_SURFACE, f.session.conversationId)).toBe(0);
      expect(JSON.parse(f.db.getSetting("outward-queue-receipt:acp-queue:k1")!)).toMatchObject({ status: "done" });
      // Draining again must not execute settled work a second time.
      await f.executor.drainAllQueued();
      expect(f.ran).toEqual(["accepted earlier"]);
    } finally { f.cleanup(); }
  });

  it("fails closed on a queued row whose Run already started instead of replaying it", async () => {
    const f = fixture();
    try {
      f.db.admitMessage(OUTWARD_ACP_SURFACE, f.session.conversationId, {
        prompt: "maybe started", chatId: f.session.sessionId, chatType: "acp", scheduledOccurrenceKey: "acp-queue:k2",
      }, 5, true);
      f.db.setSetting("outward-queue-run:acp-queue:k2", "earlier-run");
      await f.executor.drainAllQueued();
      expect(f.ran).toEqual([]);
      expect(JSON.parse(f.db.getSetting("outward-queue-receipt:acp-queue:k2")!)).toMatchObject({ status: "failed", reason: "interrupted" });
    } finally { f.cleanup(); }
  });

  it("hands a queued capacity rejection to the durable wait and replaces its receipt on Stop", async () => {
    const f = fixture();
    try {
      const queuedKey = "acp-request:s1:capacity-turn";
      f.db.admitMessage(OUTWARD_ACP_SURFACE, f.session.conversationId, {
        prompt: "resume after capacity", chatId: f.session.sessionId, chatType: "acp", scheduledOccurrenceKey: queuedKey,
      }, 5, true);
      let attempts = 0;
      const executor = new BridgeOutwardAcpPromptExecutor({
        db: f.db,
        providerChain: ["codex"] as const,
        enableDeferredCapacity: true,
        createEngine: () => ({
          executeSurfaceNeutralTurn: async (input) => {
            attempts += 1;
            input.collect(eventType.runStarted({ runId: input.runId, bot: "codex", chatId: String(input.chatId), chatKey: input.chatKey, command: "fake", cwd: f.root, model: null }));
            throw new Error("MODEL_CAPACITY_EXHAUSTED");
          },
        }),
      });
      await executor.drainQueued(f.session);
      expect(attempts).toBe(1);
      expect(f.db.pendingMsgCount(OUTWARD_ACP_SURFACE, f.session.conversationId)).toBe(0);
      expect(listRunContinuations(f.db, OUTWARD_ACP_SURFACE)).toMatchObject([
        { state: "pending", capacityWait: true, outward: { sessionId: f.session.sessionId, prompt: "resume after capacity", receiptKey: queuedKey } },
      ]);
      expect(executor.status(f.session).state).toBe("waiting");
      expect(JSON.parse(f.db.getSetting(`outward-queue-receipt:${queuedKey}`)!)).toMatchObject({ outcome: "deferred", status: "waiting" });
      const replay = await executor.execute(base(f.session, "resume after capacity", { busyMessages: true, requestId: "capacity-turn", deferCapacity: true }));
      expect((replay._meta as any)["agent-bridge"].outcome).toBe("deferred");
      expect(attempts).toBe(1);
      expect(await executor.cancel(f.session)).toBe("confirmed");
      expect(listRunContinuations(f.db, OUTWARD_ACP_SURFACE)[0]?.state).toBe("cancelled");
      expect(JSON.parse(f.db.getSetting(`outward-queue-receipt:${queuedKey}`)!)).toMatchObject({ outcome: "settled", status: "cancelled" });
      const stoppedReplay = await executor.execute(base(f.session, "resume after capacity", { busyMessages: true, requestId: "capacity-turn", deferCapacity: true }));
      expect((stoppedReplay._meta as any)["agent-bridge"]).toMatchObject({ outcome: "settled", status: "cancelled" });
      expect(attempts).toBe(1);
    } finally { f.cleanup(); }
  });

  it("records and settles a direct capacity wait receipt by request identity", async () => {
    const f = fixture();
    try {
      const executor = new BridgeOutwardAcpPromptExecutor({
        db: f.db, providerChain: ["codex"] as const, enableDeferredCapacity: true,
        createEngine: () => ({ executeSurfaceNeutralTurn: async (input) => {
          input.collect(eventType.runStarted({ runId: input.runId, bot: "codex", chatId: String(input.chatId), chatKey: input.chatKey, command: "fake", cwd: f.root, model: null }));
          throw new Error("MODEL_CAPACITY_EXHAUSTED");
        } }),
      });
      const requestId = "direct-capacity-turn";
      const baseInput = base(f.session, "direct capacity task", { busyMessages: true, requestId, deferCapacity: true });
      const deferred = await executor.execute(baseInput);
      expect((deferred._meta as any)["agent-bridge"].outcome).toBe("deferred");
      const receiptKey = `acp-request:${f.session.sessionId}:${requestId}`;
      expect(listRunContinuations(f.db, OUTWARD_ACP_SURFACE)[0]?.outward?.receiptKey).toBe(receiptKey);
      expect(JSON.parse(f.db.getSetting(`outward-queue-receipt:${receiptKey}`)!)).toMatchObject({ outcome: "deferred", status: "waiting" });
      const replay = await executor.execute(baseInput);
      expect((replay._meta as any)["agent-bridge"].outcome).toBe("deferred");
      expect(await executor.cancel(f.session)).toBe("confirmed");
      expect(JSON.parse(f.db.getSetting(`outward-queue-receipt:${receiptKey}`)!)).toMatchObject({ outcome: "settled", status: "cancelled" });
      const stoppedReplay = await executor.execute(baseInput);
      expect((stoppedReplay._meta as any)["agent-bridge"].status).toBe("cancelled");
    } finally { f.cleanup(); }
  });

  it("augment injects into a steerable live turn and otherwise falls back to the queue", async () => {
    const f = fixture();
    try {
      let release!: () => void;
      f.hold(new Promise<void>((resolve) => { release = resolve; }));
      const steered: string[] = [];
      const lane = JSON.stringify([OUTWARD_ACP_SURFACE, f.session.conversationId]);
      const coordinator = executionLaneCoordinator(f.db, OUTWARD_ACP_SURFACE);
      setLaneBusyMessageMode(f.db, OUTWARD_ACP_SURFACE, f.session.conversationId, "augment", "queue");
      const first = f.executor.execute(base(f.session, "long task"));
      while (f.ran.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));

      // Not steerable: stays durably queued.
      const queued = await f.executor.execute(base(f.session, "follow up 1", { busyMessages: true }));
      expect((queued._meta as any)["agent-bridge"].outcome).toBe("queued");

      coordinator.setSteerHandle(lane, async (text) => { steered.push(text); return { outcome: "injected" }; });
      const injected = await f.executor.execute(base(f.session, "follow up 2", { busyMessages: true, requestId: "r2" }));
      expect((injected._meta as any)["agent-bridge"].outcome).toBe("steered");
      expect(steered).toEqual(["follow up 2"]);
      expect(f.db.pendingMsgCount(OUTWARD_ACP_SURFACE, f.session.conversationId)).toBe(1);
      const replay = await f.executor.execute(base(f.session, "follow up 2", { busyMessages: true, requestId: "r2" }));
      expect((replay._meta as any)["agent-bridge"].outcome).toBe("settled");
      expect(steered).toHaveLength(1);

      coordinator.clearSteerHandle(lane);
      release();
      await first;
      await f.executor.drainQueued(f.session);
      expect(f.ran).toEqual(["long task", "follow up 1"]);
    } finally { f.cleanup(); }
  });
});
