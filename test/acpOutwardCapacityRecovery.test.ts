import { mkdtempSync, rmSync, mkdirSync, symlinkSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { OutwardAcpSessionRepository } from "../src/repositories/outwardAcpSessionRepository.js";
import { claimDueRunContinuation, listRunContinuations, linkCapacityContinuationRun, linkRunContinuationRun, requestRunContinuation, settleRunContinuation } from "../src/runContinuation.js";
import { persistProviderSession } from "../src/providers/sessionRuntime.js";
import { stageOutwardAcpAttachments, retainOutwardAcpAttachmentsForWait } from "../src/acpServer/attachments.js";
import { outwardCapacityCompletionProven, resumeOutwardCapacityWait, resumeOutwardOrdinaryContinuation } from "../src/acpServer/continuationWorker.js";
import { BridgeOutwardAcpPromptExecutor, OUTWARD_ACP_SURFACE, type OutwardAcpPromptExecutor } from "../src/acpServer/execution.js";
import { executionLaneCoordinator } from "../src/executionLaneCoordinator.js";
import { type as eventType } from "../src/events/types.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("outward ACP durable capacity worker (#1114)", () => {
  it("resumes an ordinary bound objective after database restart with no ACP client", async () => {
    const root = mkdtempSync(join(tmpdir(), "bridge-acp-ordinary-wake-"));
    roots.push(root);
    const path = join(root, "state.sqlite");
    const first = openDb(path, { databaseRole: "interactive" });
    const identity = { surfaceIdentity: OUTWARD_ACP_SURFACE, chatKey: "acp:ordinary-c1" };
    const repo = new OutwardAcpSessionRepository(first.raw);
    const session = repo.create({ sessionId: "ordinary-workstream", conversationId: identity.chatKey, cwd: root });
    first.insertRun("ordinary-origin", identity, "codex");
    persistProviderSession(first, identity, "codex", "provider-session", "ordinary-origin");
    expect(first.updateRunCompleted("ordinary-origin", "partial", "provider-session")).toBe(true);
    const now = Date.now();
    const wake = requestRunContinuation(first, {
      originRunId: "ordinary-origin", ...identity, provider: "codex",
      afterSeconds: 5, reason: "Verify the outstanding build", outwardSessionId: session.sessionId,
    }, now);
    first.close();

    const db = openDb(path, { databaseRole: "interactive" });
    try {
      const claimed = claimDueRunContinuation(db, wake.id, now + 5_001, {
        runId: "supervised-worker", claimToken: "exact-worker-claim",
      })!;
      const execute = vi.fn(async (input: any) => {
        expect(input.session.sessionId).toBe(session.sessionId);
        expect(input.prompt).toContain("Re-check current external state");
        expect(input.prompt).not.toContain("partial"); // never replay original user input
        expect(input.ordinaryResume).toEqual({
          id: wake.id, claimToken: claimed.claimToken, provider: "codex",
          providerSessionId: "provider-session",
        });
        db.insertRun("ordinary-successor", identity, "codex");
        expect(linkRunContinuationRun(db, wake.id, "ordinary-successor", claimed.claimToken)).toBe(true);
        db.raw.prepare("UPDATE bridge_runs SET outcome_status = ?, outcome_detail = ? WHERE run_id = ?")
          .run("complete", "verified", "ordinary-successor");
        db.updateRunCompleted("ordinary-successor", "verified result", "provider-session");
        return { stopReason: "end_turn" as const };
      });
      expect(await resumeOutwardOrdinaryContinuation(db, (id) => new OutwardAcpSessionRepository(db.raw).get(id),
        { execute } as unknown as OutwardAcpPromptExecutor, claimed)).toBe(true);
      settleRunContinuation(db, wake.id, "completed", undefined, Date.now(), claimed.claimToken);
      expect(db.getRun("ordinary-successor").status).toBe("done");
      expect(db.getRun("ordinary-successor").outcome_status).toBe("complete");
      expect(listRunContinuations(db, OUTWARD_ACP_SURFACE)).toEqual([
        expect.objectContaining({ id: wake.id, state: "completed", successorRunId: "ordinary-successor" }),
      ]);
    } finally { db.close(); }
  });


  it("rejects a Workstream root replaced by a symlink before background wake", async () => {
    const root = mkdtempSync(join(tmpdir(), "bridge-acp-root-switch-"));
    roots.push(root);
    const canonical = join(root, "owned");
    const redirected = join(root, "elsewhere");
    mkdirSync(canonical);
    mkdirSync(redirected);
    const link = join(root, "redirected");
    symlinkSync(redirected, link);
    const db = openDb(join(root, "state.sqlite"), { databaseRole: "interactive" });
    try {
      const session = new OutwardAcpSessionRepository(db.raw).create({
        sessionId: "symlink", conversationId: "acp:symlink", cwd: link,
      });
      db.insertRun("bad-origin", { surfaceIdentity: "acp:outward", chatKey: "acp:symlink" }, "codex");
      db.updateRunFailed("bad-origin", "MODEL_CAPACITY_EXHAUSTED");
      const now = Date.now();
      const wait = requestRunContinuation(db, {
        originRunId: "bad-origin", surfaceIdentity: "acp:outward", chatKey: "acp:symlink",
        provider: "codex", capacityWait: true, afterSeconds: 5, reason: "capacity",
        outward: { sessionId: session.sessionId, prompt: "unsafe", attachmentCount: 0 },
      }, now);
      const claimed = claimDueRunContinuation(db, wait.id, now + 6_000, { runId: "worker" })!;
      const execute = vi.fn();
      await expect(resumeOutwardCapacityWait(db, () => session, { execute } as unknown as OutwardAcpPromptExecutor, claimed))
        .rejects.toThrow("workspace path is invalid");
      expect(execute).not.toHaveBeenCalled();
    } finally { db.close(); }
  });

  it("resumes a retained task and its exact attachments after DB restart without an ACP client", async () => {
    const root = mkdtempSync(join(tmpdir(), "bridge-acp-wait-restart-"));
    roots.push(root);
    const path = join(root, "state.sqlite");
    const original = openDb(path, { databaseRole: "interactive" });
    const repo = new OutwardAcpSessionRepository(original.raw);
    const session = repo.create({ sessionId: "workstream-1", conversationId: "acp:c1", cwd: root });
    original.insertRun("capacity-origin", { surfaceIdentity: "acp:outward", chatKey: session.conversationId }, "codex");
    original.updateRunFailed("capacity-origin", "MODEL_CAPACITY_EXHAUSTED");
    const now = Date.now();
    const wait = requestRunContinuation(original, {
      originRunId: "capacity-origin", surfaceIdentity: "acp:outward",
      chatKey: session.conversationId, provider: "codex", capacityWait: true,
      reason: "provider capacity", afterSeconds: 5,
      outward: { sessionId: session.sessionId, prompt: "review report", attachmentCount: 1 },
    }, now);
    await stageOutwardAcpAttachments(root, [
      { type: "resource", resource: { uri: "file:///report.txt", mimeType: "text/plain", text: "saved payload" } },
    ], async (files) => { await retainOutwardAcpAttachmentsForWait(root, files, wait.id); });
    original.close();

    const reopened = openDb(path, { databaseRole: "interactive" });
    try {
      const claimed = claimDueRunContinuation(reopened, wait.id, now + 6_000, { runId: "worker-process" });
      expect(claimed).toMatchObject({ state: "claimed", capacityWait: true });
      const lookup = (id: string) => new OutwardAcpSessionRepository(reopened.raw).get(id);
      const execute = vi.fn(async (input: { session: { sessionId: string }; prompt: string; attachments?: string[]; capacityResume?: { id: string; claimToken: string } }) => {
        expect(input.session.sessionId).toBe("workstream-1");
        expect(input.prompt).toBe("review report");
        expect(input.attachments).toHaveLength(1);
        expect(input.capacityResume?.id).toBe(wait.id);
        return { stopReason: "end_turn" as const };
      });
      const worker = { execute } as unknown as OutwardAcpPromptExecutor;
      expect(await resumeOutwardCapacityWait(reopened, lookup, worker, claimed!)).toBe(true);
      expect(execute).toHaveBeenCalledOnce();
      expect(outwardCapacityCompletionProven(reopened, claimed!)).toBe(false);
      // A fulfilled ACP exchange without a durable successor must not let
      // the worker retire the original admitted attachment bytes.
      reopened.insertRun("recovered-successor", { surfaceIdentity: "acp:outward", chatKey: session.conversationId }, "codex");
      expect(linkCapacityContinuationRun(reopened, wait.id, claimed!.claimToken!, "recovered-successor")).toBe(true);
      expect(outwardCapacityCompletionProven(reopened, claimed!)).toBe(false);
      reopened.updateRunCompleted("recovered-successor", "restored answer", "provider-session-2");
      expect(outwardCapacityCompletionProven(reopened, claimed!)).toBe(true);
      expect(listRunContinuations(reopened, "acp:outward")[0].state).toBe("claimed");
    } finally { reopened.close(); }
  });

  it("Stop cancels a claimed capacity successor, updates its receipt and releases retained attachments", async () => {
    const root = mkdtempSync(join(tmpdir(), "bridge-acp-capacity-stop-"));
    roots.push(root);
    const path = join(root, "state.sqlite");
    const db = openDb(path, { databaseRole: "interactive", serviceId: "acp:outward:capacity-owner" });
    const observer = openDb(path, { databaseRole: "interactive", serviceId: "acp:outward:capacity-stopper" });
    const session = new OutwardAcpSessionRepository(db.raw).create({ sessionId: "capacity-stop", conversationId: "acp:capacity-stop", cwd: root });
    const requestId = "capacity-stop-receipt";
    db.insertRun("capacity-stop-origin", { surfaceIdentity: OUTWARD_ACP_SURFACE, chatKey: session.conversationId }, "codex");
    db.updateRunFailed("capacity-stop-origin", "MODEL_CAPACITY_EXHAUSTED");
    const wait = requestRunContinuation(db, {
      originRunId: "capacity-stop-origin", continuationId: "capacity-stop-wait", surfaceIdentity: OUTWARD_ACP_SURFACE,
      chatKey: session.conversationId, provider: "codex", capacityWait: true, afterSeconds: 5, reason: "capacity",
      outward: { sessionId: session.sessionId, prompt: "accepted before capacity", attachmentCount: 1, receiptKey: `acp-request:${session.sessionId}:${requestId}` },
    });
    await stageOutwardAcpAttachments(root, [
      { type: "resource", resource: { uri: "file:///capacity.txt", mimeType: "text/plain", text: "retained capacity input" } },
    ], async (files) => { await retainOutwardAcpAttachmentsForWait(root, files, wait.id); });
    const claimed = claimDueRunContinuation(db, wait.id, Date.now() + 6_000, { runId: "capacity-worker" })!;
    const lane = JSON.stringify([OUTWARD_ACP_SURFACE, session.conversationId]);
    const make = (target: typeof db) => new BridgeOutwardAcpPromptExecutor({
      db: target, providerChain: ["codex"] as const, remoteStopWaitMs: 5_000,
      createEngine: () => ({ executeSurfaceNeutralTurn: async (input) => {
        input.collect(eventType.runStarted({ runId: input.runId, bot: "codex", chatId: String(input.chatId), chatKey: input.chatKey, command: "fake", cwd: root, model: null }));
        const coordinator = executionLaneCoordinator(target, OUTWARD_ACP_SURFACE);
        while (!coordinator.isAborted(lane)) await new Promise((resolve) => setTimeout(resolve, 10));
        return { text: "", sessionId: "provider", stopReason: "cancelled" as const };
      } }),
    });
    const owner = make(db);
    const stopper = make(observer);
    try {
      const execution = owner.execute({
        session, prompt: claimed.outward!.prompt, capacityResume: { id: claimed.id, claimToken: claimed.claimToken! },
        signal: new AbortController().signal, onUpdate: () => undefined,
      });
      for (let attempt = 0; attempt < 300 && !db.listRunningRuns(OUTWARD_ACP_SURFACE).some((run) => run.chat_id === session.conversationId); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(db.listRunningRuns(OUTWARD_ACP_SURFACE).some((run) => run.chat_id === session.conversationId)).toBe(true);

      expect(await stopper.cancel(session)).toBe("confirmed");
      expect((await execution).stopReason).toBe("cancelled");
      expect(listRunContinuations(db, OUTWARD_ACP_SURFACE).find((item) => item.id === wait.id)?.state).toBe("cancelled");
      expect(readdirSync(root).some((name) => name.startsWith(".agent-bridge-attachments-wait-"))).toBe(false);
      const receipt = JSON.parse(db.getSetting(`outward-queue-receipt:acp-request:${session.sessionId}:${requestId}`)!);
      expect(receipt).toMatchObject({ outcome: "settled", status: "cancelled", continuationId: wait.id });
      const replay = await stopper.execute({ session, prompt: claimed.outward!.prompt, requestId, busyMessages: true, signal: new AbortController().signal, onUpdate: () => undefined });
      expect((replay._meta as any)["agent-bridge"]).toMatchObject({ outcome: "settled", status: "cancelled" });
    } finally {
      await owner.shutdown(); await stopper.shutdown(); db.close(); observer.close();
    }
  }, 15000);
});
