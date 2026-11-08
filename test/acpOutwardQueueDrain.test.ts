import { mkdtempSync, realpathSync, readdirSync, readFileSync, rmSync } from "node:fs";
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
import { BridgeEngine, type PendingMessage, type QueuedMessageOutcome } from "../src/engine.js";
import { SAFE_SURFACE_CAPABILITIES, type MessagingPlatform } from "../src/platform.js";
import { QUEUED_ATTACHMENT_MARKER, retainOutwardAcpAttachmentsForWait, stageOutwardAcpAttachments } from "../src/acpServer/attachments.js";

// Issue #1130: durable queue drained by a supervised owner, and augment steering.

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "outward-queue-drain-")));
  const db = openDb(join(root, "bridge.sqlite"), { databaseRole: "interactive" });
  const sessions = new OutwardAcpSessionRepository(db.raw);
  const session = sessions.create({ sessionId: "s1", conversationId: "acp:c1", cwd: root });
  const ran: string[] = [];
  let gate: Promise<void> = Promise.resolve();
  let executor!: BridgeOutwardAcpPromptExecutor;
  const core = coreQueueOwner(db, (message) => executor.executeQueuedMessage(session, message));
  executor = new BridgeOutwardAcpPromptExecutor({
    db,
    providerChain: ["codex"] as const,
    lookupSession: (id) => sessions.get(id),
    discardPendingMessages: (owner, before, after) => core.discardPendingMessages(owner.conversationId, before, after),
    createEngine: () => ({
      executeSurfaceNeutralTurn: async (input) => {
        ran.push(input.prompt);
        input.collect(eventType.runStarted({ runId: input.runId, bot: "codex", chatId: String(input.chatId), chatKey: input.chatKey, command: "fake", cwd: root, model: null }));
        await gate;
        input.collect(eventType.runCompleted({ runId: input.runId, bot: "codex", chatId: String(input.chatId), chatKey: input.chatKey, text: "ok", sessionId: "p" }));
        return { text: "ok", sessionId: "p", stopReason: "end_turn" };
      },
      recoverPendingQueue: (chatKey) => core.recoverPendingQueue(chatKey),
    }),
  });
  return { root, db, session, executor, ran, hold: (promise: Promise<void>) => { gate = promise; },
    cleanup: () => { db.close(); rmSync(root, { recursive: true, force: true }); } };
}
const base = (session: ReturnType<typeof fixture>["session"], prompt: string, extra = {}) => ({
  session, prompt, signal: new AbortController().signal, onUpdate: () => undefined, ...extra,
});

const NO_DELIVERY: MessagingPlatform = {
  capabilities: SAFE_SURFACE_CAPABILITIES,
  async sendMessage() { return {}; }, async editMessageText() { return {}; }, async sendChatAction() { return {}; },
  async answerCallbackQuery() { return {}; }, async setMyCommands() { return {}; }, async sendDocument() {}, async sendPhoto() {},
};

function coreQueueOwner(db: ReturnType<typeof openDb>, handler: (message: PendingMessage) => Promise<QueuedMessageOutcome>) {
  return new BridgeEngine({
    kind: "codex", surfaceIdentity: OUTWARD_ACP_SURFACE, botConfig: { command: "", modelPreference: [] },
    allowedUserIds: new Set(), executionMode: "safe", pollIntervalMs: 1000, hooks: { onQueuedMessage: handler },
  }, db, NO_DELIVERY);
}

describe("outward ACP durable queue ownership", () => {
  it("does not replace an expired ACP lane lease while a live Run still owns it", async () => {
    const f = fixture();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    try {
      f.hold(blocked);
      const active = f.executor.execute(base(f.session, "live owner"));
      for (let index = 0; index < 100 && f.db.listRunningRuns(OUTWARD_ACP_SURFACE).length === 0; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(f.db.listRunningRuns(OUTWARD_ACP_SURFACE)).toHaveLength(1);
      f.db.raw.prepare("UPDATE execution_locks SET lease_expires_at = ? WHERE surface = ? AND chat_key = ?")
        .run(new Date(0).toISOString(), OUTWARD_ACP_SURFACE, f.session.conversationId);
      f.db.admitMessage(OUTWARD_ACP_SURFACE, f.session.conversationId, {
        prompt: "must wait for live owner", chatId: f.session.sessionId, chatType: "acp", scheduledOccurrenceKey: "acp-queue:expired-live-owner",
      }, 5, true);
      const ran: string[] = [];
      const core = coreQueueOwner(f.db, async (message) => { ran.push(message.prompt); return "committed"; });
      expect(await core.recoverPendingQueue(f.session.conversationId, undefined, undefined, false)).toBe(true);
      expect(ran).toEqual([]);
      expect(f.db.pendingMsgCount(OUTWARD_ACP_SURFACE, f.session.conversationId)).toBe(1);
      release();
      await active;
    } finally { release(); f.cleanup(); }
  });

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

  it("retires a durable completed receipt without replaying after a queue-owner crash", async () => {
    const f = fixture();
    try {
      const key = "acp-queue:already-settled";
      f.db.admitMessage(OUTWARD_ACP_SURFACE, f.session.conversationId, {
        prompt: "must not run twice", chatId: f.session.sessionId, chatType: "acp", scheduledOccurrenceKey: key,
      }, 5, true);
      f.db.setSetting(`outward-queue-receipt:${key}`, JSON.stringify({ status: "done" }));
      await f.executor.drainAllQueued();
      expect(f.ran).toEqual([]);
      expect(f.db.pendingMsgCount(OUTWARD_ACP_SURFACE, f.session.conversationId)).toBe(0);
    } finally { f.cleanup(); }
  });

  it("preserves queued attachments through a verified capacity retry and replays as queued", async () => {
    const f = fixture();
    try {
      const key = "acp-request:s1:capacity-attachment";
      const retainedId = "acp-queue-capacity-retry";
      await stageOutwardAcpAttachments(f.root, [
        { type: "resource", resource: { uri: "file:///note.txt", mimeType: "text/plain", text: "keep me" } },
      ], (paths) => retainOutwardAcpAttachmentsForWait(f.root, paths, retainedId));
      f.db.admitMessage(OUTWARD_ACP_SURFACE, f.session.conversationId, {
        prompt: "retry with attachment", chatId: f.session.sessionId, chatType: "acp",
        attachments: [`${QUEUED_ATTACHMENT_MARKER}${retainedId}`], scheduledOccurrenceKey: key,
      }, 5, true);
      let executor!: BridgeOutwardAcpPromptExecutor;
      const core = coreQueueOwner(f.db, (message) => executor.executeQueuedMessage(f.session, message));
      let attempts = 0;
      const seen: string[] = [];
      executor = new BridgeOutwardAcpPromptExecutor({
        db: f.db, providerChain: ["codex"] as const,
        createEngine: () => ({
          executeSurfaceNeutralTurn: async (input) => {
            attempts += 1;
            seen.push(...(input.attachments ?? []).map((path) => readFileSync(path, "utf8")));
            input.collect(eventType.runStarted({ runId: input.runId, bot: "codex", chatId: String(input.chatId), chatKey: input.chatKey, command: "fake", cwd: f.root, model: null }));
            if (attempts === 1) {
              input.onProviderRecoveryDecision?.("capacity", true);
              throw new Error("MODEL_CAPACITY_EXHAUSTED");
            }
            input.collect(eventType.runCompleted({ runId: input.runId, bot: "codex", chatId: String(input.chatId), chatKey: input.chatKey, text: "ok", sessionId: "fake" }));
            return { text: "ok", sessionId: "fake", stopReason: "end_turn" };
          },
          recoverPendingQueue: (chatKey) => core.recoverPendingQueue(chatKey),
        }),
      });
      await executor.drainQueued(f.session);
      expect(JSON.parse(f.db.getSetting(`outward-queue-receipt:${key}`)!)).toMatchObject({ outcome: "queued", status: "queued" });
      const replay = await executor.execute(base(f.session, "retry with attachment", { busyMessages: true, requestId: "capacity-attachment" }));
      expect((replay._meta as any)["agent-bridge"]).toMatchObject({ outcome: "queued", status: "queued" });
      expect(readdirSync(f.root).some((name) => name.startsWith(".agent-bridge-queued-attachments-"))).toBe(true);
      for (let index = 0; index < 60 && (attempts < 2 || f.db.pendingMsgCount(OUTWARD_ACP_SURFACE, f.session.conversationId) > 0); index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(attempts).toBe(2);
      expect(seen).toEqual(["keep me", "keep me"]);
      expect(f.db.pendingMsgCount(OUTWARD_ACP_SURFACE, f.session.conversationId)).toBe(0);
      expect(JSON.parse(f.db.getSetting(`outward-queue-receipt:${key}`)!)).toMatchObject({ status: "done" });
      expect(readdirSync(f.root).some((name) => name.startsWith(".agent-bridge-queued-attachments-"))).toBe(false);
    } finally { f.cleanup(); }
  });

  it("preserves Stop's receipt when its claimed row disappears before capacity retry settlement", async () => {
    const f = fixture();
    try {
      const key = "acp-request:s1:capacity-stopped-race";
      const rowId = f.db.enqueueMsg(OUTWARD_ACP_SURFACE, f.session.conversationId, {
        prompt: "capacity retry racing Stop", chatId: f.session.sessionId, chatType: "acp", scheduledOccurrenceKey: key,
      });
      const core = coreQueueOwner(f.db, (message) => executor.executeQueuedMessage(f.session, message));
      const executor = new BridgeOutwardAcpPromptExecutor({
        db: f.db, providerChain: ["codex"] as const,
        createEngine: () => ({ executeSurfaceNeutralTurn: async (input) => {
          input.collect(eventType.runStarted({ runId: input.runId, bot: "codex", chatId: String(input.chatId), chatKey: input.chatKey, command: "fake", cwd: f.root, model: null }));
          input.onProviderRecoveryDecision?.("capacity", true);
          // Model the Stop transaction winning immediately before retry receipt
          // settlement: the queue row is gone and the cancelled receipt is durable.
          f.db.runInImmediateTransaction(() => {
            f.db.deletePendingMsg(rowId);
            f.db.setSetting(`outward-queue-receipt:${key}`, JSON.stringify({ outcome: "settled", status: "cancelled", reason: "stopped" }));
          });
          throw new Error("MODEL_CAPACITY_EXHAUSTED");
        }, recoverPendingQueue: (chatKey) => core.recoverPendingQueue(chatKey) }),
      });
      await executor.drainQueued(f.session);
      expect(f.db.pendingMsgCount(OUTWARD_ACP_SURFACE, f.session.conversationId)).toBe(0);
      expect(JSON.parse(f.db.getSetting(`outward-queue-receipt:${key}`)!)).toMatchObject({ outcome: "settled", status: "cancelled", reason: "stopped" });
    } finally { f.cleanup(); }
  });

  it("preserves Stop's receipt when a completed Run settles its retired queue claim", async () => {
    const f = fixture();
    try {
      const key = "acp-request:s1:completed-stopped-race";
      const rowId = f.db.enqueueMsg(OUTWARD_ACP_SURFACE, f.session.conversationId, {
        prompt: "completed while Stop wins", chatId: f.session.sessionId, chatType: "acp", scheduledOccurrenceKey: key,
      });
      const lane = f.db.acquireLock(OUTWARD_ACP_SURFACE, f.session.conversationId)!;
      expect(f.db.claimNextPendingMsg(lane)?.id).toBe(rowId);
      f.db.insertRun("completed-before-stop-settlement", { surfaceIdentity: OUTWARD_ACP_SURFACE, chatKey: f.session.conversationId }, "codex");
      f.db.updateRunCompleted("completed-before-stop-settlement", "done", null);
      const executor = f.executor as unknown as { settleQueuedThroughCore: (session: typeof f.session, queued: unknown, runId: string, capacityRequeue: boolean) => Promise<string> };
      f.db.runInImmediateTransaction(() => {
        f.db.deletePendingMsg(rowId);
        f.db.setSetting(`outward-queue-receipt:${key}`, JSON.stringify({ outcome: "settled", status: "cancelled", reason: "stopped" }));
      });
      expect(await executor.settleQueuedThroughCore(f.session, {
        id: rowId, laneHandle: lane, key, retainedId: null, requeued: false, coreManaged: true,
      }, "completed-before-stop-settlement", false)).toBe("settled");
      expect(JSON.parse(f.db.getSetting(`outward-queue-receipt:${key}`)!)).toMatchObject({ outcome: "settled", status: "cancelled", reason: "stopped" });
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
      let executor!: BridgeOutwardAcpPromptExecutor;
      const core = coreQueueOwner(f.db, (message) => executor.executeQueuedMessage(f.session, message));
      executor = new BridgeOutwardAcpPromptExecutor({
        db: f.db,
        providerChain: ["codex"] as const,
        enableDeferredCapacity: true,
        createEngine: () => ({
          executeSurfaceNeutralTurn: async (input) => {
            attempts += 1;
            input.collect(eventType.runStarted({ runId: input.runId, bot: "codex", chatId: String(input.chatId), chatKey: input.chatKey, command: "fake", cwd: f.root, model: null }));
            throw new Error("MODEL_CAPACITY_EXHAUSTED");
          },
          recoverPendingQueue: (chatKey) => core.recoverPendingQueue(chatKey),
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
  it("keeps Stop authoritative when an injected steering reply arrives from a cancelled claim", async () => {
    const f = fixture();
    const stopperDb = openDb(join(f.root, "bridge.sqlite"), { databaseRole: "interactive" });
    let releaseWork!: () => void;
    let releaseSteer!: () => void;
    let steerEntered!: () => void;
    const workGate = new Promise<void>((resolve) => { releaseWork = resolve; });
    const steerGate = new Promise<void>((resolve) => { releaseSteer = resolve; });
    const entered = new Promise<void>((resolve) => { steerEntered = resolve; });
    const lane = JSON.stringify([OUTWARD_ACP_SURFACE, f.session.conversationId]);
    const coordinator = executionLaneCoordinator(f.db, OUTWARD_ACP_SURFACE);
    const stopper = new BridgeOutwardAcpPromptExecutor({
      db: stopperDb,
      providerChain: ["codex"] as const,
      remoteStopWaitMs: 250,
      createEngine: () => ({
        executeSurfaceNeutralTurn: async () => { throw new Error("Stop owner must not start a Run"); },
        recoverPendingQueue: async () => true,
      }),
    });
    try {
      f.hold(workGate);
      setLaneBusyMessageMode(f.db, OUTWARD_ACP_SURFACE, f.session.conversationId, "augment", "queue");
      const active = f.executor.execute(base(f.session, "live turn"));
      while (f.ran.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
      coordinator.setSteerHandle(lane, async () => {
        steerEntered();
        await steerGate;
        return { outcome: "injected" };
      });
      const key = "acp-request:s1:steering-stop";
      const queued = f.executor.execute(base(f.session, "must not appear again", {
        busyMessages: true, requestId: "steering-stop",
      }));
      await entered;
      // A separate DB connection performs the same transactional Stop as
      // another real ACP process, while the provider steering RPC is held.
      const stop = stopper.cancel(f.session);
      expect(JSON.parse(f.db.getSetting(`outward-queue-receipt:${key}`)!))
        .toMatchObject({ status: "cancelled", reason: "stopped" });
      releaseSteer();
      releaseWork();
      const receipt = await queued;
      await Promise.all([active, stop]);
      expect((receipt._meta as any)["agent-bridge"]).toMatchObject({
        outcome: "settled", status: "cancelled",
      });
      expect(JSON.parse(f.db.getSetting(`outward-queue-receipt:${key}`)!))
        .toMatchObject({ status: "cancelled", reason: "stopped" });
      await f.executor.drainQueued(f.session);
      expect(f.ran).toEqual(["live turn"]);
      expect(f.db.pendingMsgCount(OUTWARD_ACP_SURFACE, f.session.conversationId)).toBe(0);
    } finally {
      releaseSteer();
      releaseWork();
      coordinator.clearSteerHandle(lane);
      stopperDb.close();
      f.cleanup();
    }
  }, 12_000);

  it("fails closed after an injected steer loses its queue claim without a Stop", async () => {
    const f = fixture();
    let releaseWork!: () => void;
    let releaseSteer!: () => void;
    let steerEntered!: () => void;
    const workGate = new Promise<void>((resolve) => { releaseWork = resolve; });
    const steerGate = new Promise<void>((resolve) => { releaseSteer = resolve; });
    const entered = new Promise<void>((resolve) => { steerEntered = resolve; });
    const lane = JSON.stringify([OUTWARD_ACP_SURFACE, f.session.conversationId]);
    const coordinator = executionLaneCoordinator(f.db, OUTWARD_ACP_SURFACE);
    try {
      f.hold(workGate);
      setLaneBusyMessageMode(f.db, OUTWARD_ACP_SURFACE, f.session.conversationId, "augment", "queue");
      const active = f.executor.execute(base(f.session, "live turn"));
      while (f.ran.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
      coordinator.setSteerHandle(lane, async () => {
        steerEntered();
        await steerGate;
        return { outcome: "injected" };
      });
      const key = "acp-request:s1:steering-lease-lost";
      const queued = f.executor.execute(base(f.session, "irreversible injection", {
        busyMessages: true, requestId: "steering-lease-lost",
      }));
      await entered;
      const id = f.db.getPendingMessageIdByCorrelationKey(OUTWARD_ACP_SURFACE, key);
      expect(id).not.toBeNull();
      // A lease/claim transition after the provider accepted content: the
      // old claimant must neither delete an unowned row nor replay the text.
      f.db.raw.prepare(`UPDATE pending_messages
        SET state = 'queued', claim_run_id = NULL, claim_acquisition_id = NULL, claimed_at = NULL
        WHERE id = ?`).run(id);
      releaseSteer();
      const receipt = await queued;
      expect((receipt._meta as any)["agent-bridge"]).toMatchObject({
        outcome: "settled", status: "uncertain", reason: "steering_claim_lost",
      });
      releaseWork();
      await active;
      await f.executor.drainQueued(f.session);
      expect(f.ran).toEqual(["live turn"]);
      expect(f.db.pendingMsgCount(OUTWARD_ACP_SURFACE, f.session.conversationId)).toBe(0);
      const retry = await f.executor.execute(base(f.session, "irreversible injection", {
        busyMessages: true, requestId: "steering-lease-lost",
      }));
      expect((retry._meta as any)["agent-bridge"]).toMatchObject({
        outcome: "settled", status: "uncertain",
      });
      expect(f.ran).toEqual(["live turn"]);
    } finally {
      releaseSteer();
      releaseWork();
      coordinator.clearSteerHandle(lane);
      f.cleanup();
    }
  }, 12_000);

});
