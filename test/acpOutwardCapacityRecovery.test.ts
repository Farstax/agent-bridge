import { mkdtempSync, rmSync, mkdirSync, symlinkSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { OutwardAcpSessionRepository } from "../src/repositories/outwardAcpSessionRepository.js";
import { acceptedContinuationObjective, claimDueRunContinuation, listRunContinuations, linkCapacityContinuationRun, linkRunContinuationRun, requestRunContinuation, scanRunContinuations, settleRunContinuation } from "../src/runContinuation.js";
import { lookupProviderSession, persistProviderSession } from "../src/providers/sessionRuntime.js";
import { getStoredCliPreference, setUserCliPreference } from "../src/interactiveBot.js";
import { attachProviderFailureEvidence } from "../src/providers/failureEvidence.js";
import { recordRunOutcome } from "../src/runOutcome.js";
import { stageOutwardAcpAttachments, retainOutwardAcpAttachmentsForWait } from "../src/acpServer/attachments.js";
import { outwardCapacityCompletionProven, resumeOutwardCapacityWait, resumeOutwardOrdinaryContinuation } from "../src/acpServer/continuationWorker.js";
import { BridgeOutwardAcpPromptExecutor, OUTWARD_ACP_SURFACE, type OutwardAcpPromptExecutor } from "../src/acpServer/execution.js";
import { executionLaneCoordinator } from "../src/executionLaneCoordinator.js";
import { BridgeEngine } from "../src/engine.js";
import { acpEngineExec } from "./support/acpEngineExec.js";
import { isHandoffRequired } from "../src/handoffState.js";
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
    const now = Date.now();
    const wake = requestRunContinuation(first, {
      originRunId: "ordinary-origin", ...identity, provider: "codex",
      afterSeconds: 5, reason: "Verify the outstanding build", outwardSessionId: session.sessionId,
    }, now);
    expect(first.updateRunCompleted("ordinary-origin", "partial", "provider-session")).toBe(true);
    // Archive is Workstream metadata only (ADR-005); it must not retire the wake.
    expect(repo.update(session.sessionId, { archived: true })?.archivedAt).toBeTruthy();
    first.close();

    const db = openDb(path, { databaseRole: "interactive" });
    try {
      expect(listRunContinuations(db, OUTWARD_ACP_SURFACE)).toEqual([expect.objectContaining({ id: wake.id, state: "pending" })]);
      expect(new OutwardAcpSessionRepository(db.raw).update(session.sessionId, { archived: false })?.archivedAt).toBeNull();
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
        const lane = db.acquireLock(identity.surfaceIdentity, identity.chatKey)!;
        expect(linkRunContinuationRun(db, wake.id, "ordinary-successor", claimed.claimToken, "codex", lane)).toBe(true);
        db.unlock(lane);
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



  it("retains the accepted objective when a real outward Run schedules a wake", async () => {
    const root = mkdtempSync(join(tmpdir(), "bridge-objective-link-")); roots.push(root);
    const db = openDb(join(root, "state.sqlite"), { databaseRole: "interactive" });
    const repo = new OutwardAcpSessionRepository(db.raw);
    const session = repo.create({ sessionId: "objective-ws", conversationId: "acp:objective-ws", cwd: root });
    const identity = { surfaceIdentity: OUTWARD_ACP_SURFACE, chatKey: session.conversationId };
    const executor = new BridgeOutwardAcpPromptExecutor({ db, providerChain: ["codex"], enableDeferredCapacity: true,
      lookupSession: (id) => repo.get(id), runId: () => "objective-origin", createEngine: () => ({
        executeSurfaceNeutralTurn: async (turn) => {
          turn.collect(eventType.runStarted({ runId: turn.runId, bot: "codex", chatId: String(turn.chatId),
            chatKey: turn.chatKey, command: "fake", cwd: root, model: null }));
          recordRunOutcome(db, { runId: turn.runId, ...identity, provider: "codex", status: "continue", detail: "check",
            lock: { serviceId: turn.laneHandle.serviceId, runId: turn.laneHandle.runId, acquisitionId: turn.laneHandle.acquisitionId } });
          requestRunContinuation(db, { originRunId: turn.runId, ...identity, provider: "codex", reason: "check",
            afterSeconds: 5, outwardSessionId: session.sessionId });
          return { text: "pending", sessionId: "native", stopReason: "end_turn" as const };
        },
      }) });
    try {
      await executor.execute({ session, prompt: "Inspect the build", ordinaryContinuations: true,
        signal: new AbortController().signal, onUpdate: () => undefined });
      const wake = listRunContinuations(db, OUTWARD_ACP_SURFACE)[0];
      expect(acceptedContinuationObjective(db, wake)?.text).toBe("Inspect the build");
      const calls: string[] = [];
      const worker = new BridgeOutwardAcpPromptExecutor({ db, providerChain: ["codex", "claude"],
        enableDeferredCapacity: true, isProviderAvailable: () => true, lookupSession: (id) => repo.get(id),
        runId: () => "objective-successor", createEngine: (_session, provider) => ({
          executeSurfaceNeutralTurn: async (turn) => {
            calls.push(provider);
            expect(provider).toBe("claude");
            expect(lookupProviderSession(db, identity, provider)).toBe("intermediate-native");
            expect(turn.freshProviderSession).toBe(false);
            expect(turn.prompt).toContain("Inspect the build");
            expect(turn.prompt).toMatch(/never blindly replay/i);
            turn.collect(eventType.runStarted({ runId: turn.runId, bot: provider, chatId: String(turn.chatId),
              chatKey: turn.chatKey, command: "fake", cwd: root, model: null }));
            recordRunOutcome(db, { runId: turn.runId, ...identity, provider, status: "complete", detail: "verified",
              lock: { serviceId: turn.laneHandle.serviceId, runId: turn.laneHandle.runId, acquisitionId: turn.laneHandle.acquisitionId } });
            return { text: "verified", sessionId: "claude-native", stopReason: "end_turn" as const };
          },
        }) });
      try {
        expect(worker.selectProvider(session, "claude").selectedProvider).toBe("claude");
        expect(isHandoffRequired(db, OUTWARD_ACP_SURFACE, identity.chatKey, "claude")).toBe(true);
        const client = { capabilities: {}, sendMessage: async () => ({}), editMessageText: async () => ({}),
          sendChatAction: async () => ({}), answerCallbackQuery: async () => ({}), setMyCommands: async () => ({}),
          sendDocument: async () => ({}), sendPhoto: async () => ({}) } as any;
        const engine = new BridgeEngine({ surfaceIdentity: OUTWARD_ACP_SURFACE, kind: "claude",
          botConfig: { command: "claude", modelPreference: [] }, allowedUserIds: new Set(),
          executionMode: "safe", pollIntervalMs: 1000, workingDir: root }, db, client,
          acpEngineExec(vi.fn().mockResolvedValue(JSON.stringify({ type: "text", data: "intervening" }) + "\n" +
            JSON.stringify({ type: "end", sessionId: "intermediate-native", stopReason: "end_turn" }))));
        const intermediate = new BridgeOutwardAcpPromptExecutor({ db, providerChain: ["codex", "claude"],
          lookupSession: (id) => repo.get(id), runId: () => "intermediate-run",
          createEngine: () => ({ executeSurfaceNeutralTurn: (turn) => engine.executeSurfaceNeutralTurn(turn) }) });
        try {
          await intermediate.execute({ session, prompt: "Inspect status", signal: new AbortController().signal, onUpdate: () => undefined });
          expect(db.getRun("intermediate-run").status).toBe("done");
          expect(isHandoffRequired(db, OUTWARD_ACP_SURFACE, identity.chatKey, "claude")).toBe(false);
        } finally { await intermediate.shutdown(); }
        const claim = claimDueRunContinuation(db, wake.id, Date.parse(wake.dueAt) + 1,
          { runId: "worker", claimToken: "objective-claim" })!;
        expect(await resumeOutwardOrdinaryContinuation(db, (id) => repo.get(id), worker, claim)).toBe(true);
        expect(calls).toEqual(["claude"]);
        expect(db.getRun("objective-successor")).toMatchObject({ bot: "claude", status: "done", outcome_status: "complete" });
      } finally { await worker.shutdown(); }
    } finally { await executor.shutdown(); db.close(); }
  });

  for (const { staleWorker, fallbackOrigin, switched, awayBack, replaced, proven, forged, removedSelected } of [
    { staleWorker: true, fallbackOrigin: false, switched: false, awayBack: false, replaced: false, proven: false, forged: false, removedSelected: false },
    { staleWorker: false, fallbackOrigin: false, switched: false, awayBack: false, replaced: false, proven: false, forged: false, removedSelected: false },
    { staleWorker: false, fallbackOrigin: true, switched: false, awayBack: false, replaced: false, proven: false, forged: false, removedSelected: false },
    { staleWorker: false, fallbackOrigin: false, switched: true, awayBack: false, replaced: false, proven: false, forged: false, removedSelected: false },
    { staleWorker: false, fallbackOrigin: false, switched: true, awayBack: true, replaced: false, proven: false, forged: false, removedSelected: false },
    { staleWorker: false, fallbackOrigin: false, switched: true, awayBack: true, replaced: true, proven: false, forged: false, removedSelected: false },
    { staleWorker: false, fallbackOrigin: false, switched: true, awayBack: true, replaced: false, proven: true, forged: false },
    { staleWorker: false, fallbackOrigin: false, switched: true, awayBack: true, replaced: false, proven: true, forged: true, removedSelected: false },
    { staleWorker: true, fallbackOrigin: false, switched: true, awayBack: false, replaced: false, proven: false, forged: false, removedSelected: true },
  ]) {
    it(`unchanged Antigravity selection with restarted worker (stale=${staleWorker}, fallback=${fallbackOrigin}, switched=${switched}, awayBack=${awayBack}, replaced=${replaced}, proven=${proven}, forged=${forged}, removedSelected=${removedSelected})`, async () => {
      const root = mkdtempSync(join(tmpdir(), "bridge-ordinary-agy-"));
      roots.push(root);
      const path = join(root, "state.sqlite");
      const first = openDb(path, { databaseRole: "interactive" });
      const identity = { surfaceIdentity: OUTWARD_ACP_SURFACE, chatKey: "acp:unchanged-agy" };
      const session = new OutwardAcpSessionRepository(first.raw).create({
        sessionId: "agy-workstream", conversationId: identity.chatKey, cwd: root,
      });
      const desk = new BridgeOutwardAcpPromptExecutor({
        db: first, providerChain: ["codex", "claude", "grok", "antigravity"],
        createEngine: () => { throw new Error("selection must not invoke a provider"); },
        lookupSession: (id) => new OutwardAcpSessionRepository(first.raw).get(id),
      });
      const now = Date.now();
      let wakeId: string;
      try {
        expect(desk.selectProvider(session, fallbackOrigin ? "codex" : "antigravity").selectedProvider)
          .toBe(fallbackOrigin ? "codex" : "antigravity");
        const turnId = first.addConvTurn(identity.chatKey, "user", "Verify the outstanding build", "antigravity",
          { surfaceIdentity: OUTWARD_ACP_SURFACE });
        first.insertRun("agy-previous", identity, "antigravity");
        persistProviderSession(first, identity, "antigravity", "agy-native-session", "agy-previous");
        expect(first.updateRunCompleted("agy-previous", "previous result", "agy-native-session")).toBe(true);
        first.insertRun("agy-origin", identity, "antigravity");
        first.setSetting("outward-run-accepted-turn:v1:agy-origin", String(turnId));
        persistProviderSession(first, identity, "antigravity", "agy-native-session", "agy-origin");
        wakeId = requestRunContinuation(first, {
          originRunId: "agy-origin", ...identity, provider: "antigravity",
          afterSeconds: 5, reason: "Verify the outstanding build", outwardSessionId: session.sessionId,
        }, now).id;
        expect(first.updateRunCompleted("agy-origin", "partial", "agy-native-session")).toBe(true);
        expect(acceptedContinuationObjective(first, listRunContinuations(first, OUTWARD_ACP_SURFACE).find((item) => item.id === wakeId)!))
          .toEqual({ id: turnId, text: "Verify the outstanding build" });
        if (switched) expect(desk.selectProvider(session, "codex").selectedProvider).toBe("codex");
        if (awayBack) expect(desk.selectProvider(session, "antigravity").selectedProvider).toBe("antigravity");
        if (replaced) persistProviderSession(first, identity, "antigravity", "unproven-session", "agy-origin");
        if (proven) {
          first.insertRun("intervening", identity, "antigravity");
          persistProviderSession(first, identity, "antigravity", "intervening-session", "intervening");
          expect(first.updateRunCompleted("intervening", "inspected", "intervening-session")).toBe(true);
          if (forged) persistProviderSession(first, identity, "antigravity", "intervening-session", "agy-origin");
        }
      } finally { await desk.shutdown(); first.close(); }

      // Independent fresh wakes: never resurrect a terminal failed incident.
      const db = openDb(path, { databaseRole: "interactive" });
      const lookup = (id: string) => new OutwardAcpSessionRepository(db.raw).get(id);
      const calls: Array<{ provider: string; nativeSession: string | null }> = [];
      const worker = new BridgeOutwardAcpPromptExecutor({
        db, providerChain: removedSelected ? ["claude", "grok"] : staleWorker ? ["codex", "claude", "grok"] : ["codex", "claude", "grok", "antigravity"],
        isProviderAvailable: () => true, enableDeferredCapacity: true, lookupSession: lookup,
        runId: () => "agy-successor",
        createEngine: (_session, provider) => ({
          executeSurfaceNeutralTurn: async (turn) => {
            const nativeSession = turn.freshProviderSession ? null : lookupProviderSession(db, identity, provider);
            calls.push({ provider, nativeSession });
            if (!switched) expect(turn.requireBoundProviderSession).toBe(true);
            else {
              expect(turn.prompt).toContain("Verify the outstanding build");
              expect(turn.prompt).toMatch(/never blindly replay/i);
            }
            turn.collect(eventType.runStarted({
              runId: turn.runId, bot: provider, chatId: String(turn.chatId),
              chatKey: turn.chatKey, command: "fake", cwd: root, model: null,
            }));
            recordRunOutcome(db, {
              runId: turn.runId, ...identity, provider, status: "complete", detail: "verified",
              lock: { serviceId: turn.laneHandle.serviceId, runId: turn.laneHandle.runId,
                acquisitionId: turn.laneHandle.acquisitionId },
            });
            return { text: "Verified result.", sessionId: proven ? "intervening-session" : awayBack ? "agy-new-session" : switched ? "codex-native-session" : "agy-native-session", stopReason: "end_turn" as const };
          },
        }),
      });
      try {
        await scanRunContinuations(db, OUTWARD_ACP_SURFACE,
          (claimed) => resumeOutwardOrdinaryContinuation(db, lookup, worker, claimed), now + 5_001,
          { runId: "agy-worker", claimToken: "agy-exact-claim" });
        const wake = listRunContinuations(db, OUTWARD_ACP_SURFACE).find((item) => item.id === wakeId)!;
        expect(wake.provider).toBe("antigravity");
        expect(lookupProviderSession(db, identity, "antigravity")).toBe(replaced ? "unproven-session" : proven ? "intervening-session" : awayBack ? "agy-new-session" : "agy-native-session");
        expect(db.getConvHistoryPage(identity.chatKey, 10, undefined, OUTWARD_ACP_SURFACE).turnCount).toBe(1);
        if (replaced || forged) {
          expect(calls).toEqual([]);
          expect(wake.state).toBe("cancelled");
          expect(wake.successorRunId).toBeUndefined();
          expect(db.getSetting("outward-run-accepted-turn:v1:agy-origin")).toBeNull();
        } else if (staleWorker) {
          expect(calls).toEqual([]);
          expect(wake.state).toBe("failed");
          expect(wake.successorRunId).toBeUndefined();
          expect(wake.error).toMatch(/configur/i);
          expect(wake.error).not.toContain("authority changed");
          expect(db.getSetting("outward-run-accepted-turn:v1:agy-origin")).toBeNull();
        } else {
          expect(calls).toEqual([switched ? { provider: awayBack ? "antigravity" : "codex", nativeSession: proven ? "intervening-session" : null }
            : { provider: "antigravity", nativeSession: "agy-native-session" }]);
          expect(wake).toMatchObject({ state: "completed", successorRunId: "agy-successor" });
          // Provenance is retired once no live wake traces to the accepted turn.
          expect(db.getSetting("outward-run-accepted-turn:v1:agy-origin")).toBeNull();
          expect(db.getRun("agy-successor")).toMatchObject({
            status: "done", bot: switched && !awayBack ? "codex" : "antigravity", session_id: proven ? "intervening-session" : awayBack ? "agy-new-session" : switched ? "codex-native-session" : "agy-native-session", outcome_status: "complete",
          });
          expect(worker.status(session).selectedProvider).toBe(fallbackOrigin || (switched && !awayBack) ? "codex" : "antigravity");
        }
        expect((db.raw.prepare("SELECT count(*) AS n FROM bridge_runs WHERE chat_id = ?")
          .get(identity.chatKey) as { n: number }).n).toBe(forged ? 3 : proven ? 4 : staleWorker || replaced ? 2 : 3);
      } finally { await worker.shutdown(); db.close(); }
    });
  }

  for (const failureMode of ["systemError", "quota"] as const) {
  it(`a claimed Codex continuation reaches Claude in its original fenced successor Run (${failureMode})`, async () => {
    const root = mkdtempSync(join(tmpdir(), "bridge-1281-portable-wake-"));
    roots.push(root);
    const db = openDb(join(root, "state.sqlite"), { databaseRole: "interactive" });
    const identity = { surfaceIdentity: OUTWARD_ACP_SURFACE, chatKey: "acp:portable-continuation" };
    const session = new OutwardAcpSessionRepository(db.raw).create({
      sessionId: "portable-workstream", conversationId: identity.chatKey, cwd: root,
    });
    setUserCliPreference(db, identity, "codex");
    db.insertRun("portable-origin", identity, "codex");
    persistProviderSession(db, identity, "codex", "codex-original-native-session", "portable-origin");
    const now = Date.now();
    const wake = requestRunContinuation(db, {
      originRunId: "portable-origin", ...identity, provider: "codex",
      reason: "finish the previously started task", afterSeconds: 5,
      outwardSessionId: session.sessionId,
    }, now);
    expect(db.updateRunCompleted("portable-origin", "partial", "codex-original-native-session")).toBe(true);
    const claimed = claimDueRunContinuation(db, wake.id, now + 5_001, {
      runId: "portable-worker", claimToken: "portable-claim",
    })!;
    const attempts: Array<{ provider: string; session: string | null; bound: boolean | undefined; prompt: string }> = [];
    let priorToolEffects = 0;
    const executor = new BridgeOutwardAcpPromptExecutor({
      db, providerChain: ["codex", "claude"],
      isProviderAvailable: () => true,
      enableDeferredCapacity: true,
      lookupSession: (id) => new OutwardAcpSessionRepository(db.raw).get(id),
      runId: () => "portable-successor",
      createEngine: (_session, provider) => ({
        executeSurfaceNeutralTurn: async (turn) => {
          const nativeSession = turn.freshProviderSession ? null : lookupProviderSession(db, identity, provider);
          attempts.push({
            provider, session: nativeSession, bound: turn.requireBoundProviderSession, prompt: turn.prompt,
          });
          turn.collect(eventType.runStarted({
            runId: turn.runId, bot: provider, chatId: String(turn.chatId),
            chatKey: turn.chatKey, command: "fake", cwd: root, model: null,
          }));
          if (provider === "codex") {
            if (attempts.length === 1) priorToolEffects = 9; // simulated prior tool activity
            const error = failureMode === "quota"
              ? new Error("RequestError: Codex usage limit reached; try again after quota reset")
              : new Error("AcpSystemError: resumed Codex session stopped after tool activity");
            error.name = failureMode === "quota" ? "RequestError" : "AcpSystemError";
            throw attachProviderFailureEvidence(error, { promptSubmitted: true });
          }
          expect(priorToolEffects).toBe(9); // no earlier operation was replayed
          expect(turn.prompt).toContain("Inspect previous tool actions");
          recordRunOutcome(db, {
            runId: turn.runId, ...identity, chatKey: identity.chatKey, provider,
            status: "continue", detail: "check final external result",
            lock: {
              serviceId: turn.laneHandle.serviceId, runId: turn.laneHandle.runId,
              acquisitionId: turn.laneHandle.acquisitionId,
            },
          });
          requestRunContinuation(db, {
            originRunId: turn.runId, ...identity, provider,
            reason: "check final external result", afterSeconds: 60,
            outwardSessionId: session.sessionId,
          });
          return { text: "Outstanding task advanced; final check scheduled.", sessionId: "claude-new-native-session", stopReason: "end_turn" as const };
        },
      }),
    });
    try {
      const ok = await resumeOutwardOrdinaryContinuation(
        db, (id) => new OutwardAcpSessionRepository(db.raw).get(id), executor, claimed,
      );
      expect(ok).toBe(true);
      expect(attempts.map((item) => item.provider)).toEqual(
        failureMode === "quota" ? ["codex", "claude"] : ["codex", "codex", "claude"]);
      expect(attempts.map((item) => item.session)).toEqual(
        failureMode === "quota" ? ["codex-original-native-session", null] : ["codex-original-native-session", null, null]);
      expect(attempts.map((item) => item.bound)).toEqual(
        failureMode === "quota" ? [true, false] : [true, false, false]);
      expect(attempts.at(-1)?.prompt).toContain(failureMode === "quota" ? "usage limit" : "AcpSystemError");
      expect(db.getRun("portable-successor")).toMatchObject({
        status: "done", bot: "claude", outcome_status: "continue",
        session_id: "claude-new-native-session",
      });
      expect(lookupProviderSession(db, identity, "codex")).toBe("codex-original-native-session");
      expect(lookupProviderSession(db, identity, "claude")).toBe("claude-new-native-session");
      expect(getStoredCliPreference(db, identity)).toBe("codex");
      const continuations = listRunContinuations(db, OUTWARD_ACP_SURFACE);
      expect(continuations.find((item) => item.id === wake.id)).toMatchObject({
        state: "claimed", successorRunId: "portable-successor",
      });
      expect(continuations.find((item) => item.originRunId === "portable-successor")).toMatchObject({
        provider: "claude", state: "pending", outwardSessionId: session.sessionId,
      });
      const next = continuations.find((item) => item.originRunId === "portable-successor")!;
      const nextClaim = claimDueRunContinuation(db, next.id, Date.parse(next.dueAt) + 1,
        { runId: "next-worker", claimToken: "next-claim" })!;
      const laterCalls: string[] = [];
      const later = new BridgeOutwardAcpPromptExecutor({
        db, providerChain: ["codex", "claude"], enableDeferredCapacity: true,
        isProviderAvailable: () => true, lookupSession: (id) => new OutwardAcpSessionRepository(db.raw).get(id),
        runId: () => "fallback-followup",
        createEngine: (_session, provider) => ({ executeSurfaceNeutralTurn: async (turn) => {
          laterCalls.push(provider);
          expect(lookupProviderSession(db, identity, provider)).toBe("claude-new-native-session");
          expect(turn.requireBoundProviderSession).toBe(true);
          turn.collect(eventType.runStarted({ runId: turn.runId, bot: provider, chatId: String(turn.chatId),
            chatKey: turn.chatKey, command: "fake", cwd: root, model: null }));
          recordRunOutcome(db, { runId: turn.runId, ...identity, provider, status: "complete", detail: "verified",
            lock: { serviceId: turn.laneHandle.serviceId, runId: turn.laneHandle.runId, acquisitionId: turn.laneHandle.acquisitionId } });
          return { text: "verified", sessionId: "claude-new-native-session", stopReason: "end_turn" as const };
        } }),
      });
      try {
        expect(await resumeOutwardOrdinaryContinuation(db,
          (id) => new OutwardAcpSessionRepository(db.raw).get(id), later, nextClaim)).toBe(true);
        expect(laterCalls).toEqual(["claude"]);
        expect(db.getRun("fallback-followup")).toMatchObject({ bot: "claude", status: "done", outcome_status: "complete" });
      } finally { await later.shutdown(); }
      expect((db.raw.prepare("SELECT count(*) AS n FROM bridge_runs WHERE chat_id = ?")
        .get(identity.chatKey) as { n: number }).n).toBe(3);
    } finally { await executor.shutdown(); db.close(); }
  });
  }

  it.each([
    ["2000-01-01T00:00:00.000Z", false], ["invalid-date", false],
    ["2000-01-01T00:00:00.000Z", true], ["invalid-date", true],
  ])("rejects an expired or malformed claimed lease (%s, busy=%s)", async (expiry, busy) => {
    const root = mkdtempSync(join(tmpdir(), "bridge-expired-claim-")); roots.push(root);
    const db = openDb(join(root, "state.sqlite"), { databaseRole: "interactive" });
    const identity = { surfaceIdentity: OUTWARD_ACP_SURFACE, chatKey: "acp:expired-claim" };
    const repo = new OutwardAcpSessionRepository(db.raw);
    const session = repo.create({ sessionId: "expired-workstream", conversationId: identity.chatKey, cwd: root });
    db.insertRun("expired-origin", identity, "codex");
    persistProviderSession(db, identity, "codex", "native-session", "expired-origin");
    const now = Date.now();
    const wake = requestRunContinuation(db, { originRunId: "expired-origin", ...identity, provider: "codex",
      reason: "verify", afterSeconds: 5, outwardSessionId: session.sessionId }, now);
    db.updateRunCompleted("expired-origin", "pending", "native-session");
    const claim = claimDueRunContinuation(db, wake.id, now + 5001, { runId: "worker", claimToken: "claim" })!;
    db.setSetting(`run-continuation:v1:${wake.id}`, JSON.stringify({ ...claim, claimExpiresAt: expiry }));
    const execute = vi.fn();
    const executor = new BridgeOutwardAcpPromptExecutor({ db, providerChain: ["codex"], enableDeferredCapacity: true,
      lookupSession: (id) => repo.get(id), createEngine: () => ({ executeSurfaceNeutralTurn: execute }) });
    const lane = busy ? db.acquireLock(OUTWARD_ACP_SURFACE, identity.chatKey)! : null;
    try {
      await expect(resumeOutwardOrdinaryContinuation(db, (id) => repo.get(id), executor, claim)).rejects.toThrow();
      expect(execute).not.toHaveBeenCalled();
      expect(db.pendingMsgCount(OUTWARD_ACP_SURFACE, identity.chatKey)).toBe(0);
      expect(listRunContinuations(db, OUTWARD_ACP_SURFACE)[0].successorRunId).toBeUndefined();
    } finally { if (lane) db.unlock(lane); await executor.shutdown(); db.close(); }
  });

  it("does not admit a claimed wake past its own expiry", async () => {
    const root = mkdtempSync(join(tmpdir(), "bridge-expired-wake-")); roots.push(root);
    const db = openDb(join(root, "state.sqlite"), { databaseRole: "interactive" });
    const identity = { surfaceIdentity: OUTWARD_ACP_SURFACE, chatKey: "acp:expired-wake" };
    const repo = new OutwardAcpSessionRepository(db.raw);
    const session = repo.create({ sessionId: "expired-ws", conversationId: identity.chatKey, cwd: root });
    db.insertRun("origin", identity, "codex"); persistProviderSession(db, identity, "codex", "native", "origin");
    const now = Date.now();
    const wake = requestRunContinuation(db, { originRunId: "origin", ...identity, provider: "codex",
      reason: "verify", afterSeconds: 5, outwardSessionId: session.sessionId }, now);
    db.updateRunCompleted("origin", "pending", "native");
    const claim = claimDueRunContinuation(db, wake.id, now + 5001, { runId: "worker", claimToken: "claim" })!;
    db.setSetting(`run-continuation:v1:${wake.id}`, JSON.stringify({ ...claim, expiresAt: new Date(now - 1).toISOString() }));
    const invoke = vi.fn();
    const executor = new BridgeOutwardAcpPromptExecutor({ db, providerChain: ["codex"], enableDeferredCapacity: true,
      lookupSession: (id) => repo.get(id), createEngine: () => ({ executeSurfaceNeutralTurn: invoke }) });
    try {
      await expect(resumeOutwardOrdinaryContinuation(db, (id) => repo.get(id), executor, claim)).rejects.toThrow();
      expect(invoke).not.toHaveBeenCalled();
      expect(listRunContinuations(db, OUTWARD_ACP_SURFACE)[0]).toMatchObject({ state: "expired" });
      expect(listRunContinuations(db, OUTWARD_ACP_SURFACE)[0].successorRunId).toBeUndefined();
    } finally { await executor.shutdown(); db.close(); }
  });

  it("Stop cancels a claimed ordinary wake before successor Run admission", async () => {
    const root = mkdtempSync(join(tmpdir(), "bridge-acp-ordinary-stop-"));
    roots.push(root);
    const db = openDb(join(root, "state.sqlite"), { databaseRole: "interactive" });
    const session = new OutwardAcpSessionRepository(db.raw).create({
      sessionId: "ordinary-stop-ws", conversationId: "acp:ordinary-stop", cwd: root,
    });
    const identity = { surfaceIdentity: OUTWARD_ACP_SURFACE, chatKey: session.conversationId };
    db.insertRun("ordinary-stop-origin", identity, "codex");
    persistProviderSession(db, identity, "codex", "original-native-session", "ordinary-stop-origin");
    const now = Date.now();
    const wake = requestRunContinuation(db, {
      originRunId: "ordinary-stop-origin", ...identity, provider: "codex",
      reason: "continue after delay", afterSeconds: 5, outwardSessionId: session.sessionId,
    }, now);
    expect(db.updateRunCompleted("ordinary-stop-origin", "pending operation", "original-native-session")).toBe(true);
    const claimed = claimDueRunContinuation(db, wake.id, now + 5_001, {
      runId: "worker", claimToken: "stop-race-claim",
    });
    expect(claimed?.state).toBe("claimed");
    const engine = { executeSurfaceNeutralTurn: vi.fn() };
    const executor = new BridgeOutwardAcpPromptExecutor({
      db, providerChain: ["codex"], createEngine: () => engine,
      lookupSession: (id) => new OutwardAcpSessionRepository(db.raw).get(id),
    });
    try {
      expect(await executor.cancel(session)).toBe("confirmed");
      expect(listRunContinuations(db, OUTWARD_ACP_SURFACE)).toEqual([
        expect.objectContaining({ id: wake.id, state: "cancelled" }),
      ]);
      db.insertRun("would-be-successor", identity, "codex");
      expect(linkRunContinuationRun(db, wake.id, "would-be-successor", "stop-race-claim")).toBe(false);
      expect(engine.executeSurfaceNeutralTurn).not.toHaveBeenCalled();
      await expect(resumeOutwardOrdinaryContinuation(db,
        (id) => new OutwardAcpSessionRepository(db.raw).get(id), executor, claimed!)).rejects.toThrow();
      expect(engine.executeSurfaceNeutralTurn).not.toHaveBeenCalled();
      expect(db.pendingMsgCount(OUTWARD_ACP_SURFACE, identity.chatKey)).toBe(0);
      expect(listRunContinuations(db, OUTWARD_ACP_SURFACE)[0]).toMatchObject({ state: "cancelled" });
    } finally { await executor.shutdown(); db.close(); }
  });

  it("rejects an ordinary wake when its Workstream root resolves through a symlink", async () => {
    const root = mkdtempSync(join(tmpdir(), "bridge-ordinary-root-")); roots.push(root);
    const owned = join(root, "owned"); mkdirSync(owned);
    const link = join(root, "alias"); symlinkSync(owned, link);
    const db = openDb(join(root, "state.sqlite"), { databaseRole: "interactive" });
    try {
      const repo = new OutwardAcpSessionRepository(db.raw);
      const session = repo.create({ sessionId: "root-ws", conversationId: "acp:root-ws", cwd: link });
      const identity = { surfaceIdentity: OUTWARD_ACP_SURFACE, chatKey: session.conversationId };
      db.insertRun("root-origin", identity, "codex");
      persistProviderSession(db, identity, "codex", "native", "root-origin");
      const now = Date.now();
      const wake = requestRunContinuation(db, { originRunId: "root-origin", ...identity, provider: "codex",
        reason: "verify", afterSeconds: 5, outwardSessionId: session.sessionId }, now);
      db.updateRunCompleted("root-origin", "pending", "native");
      const claim = claimDueRunContinuation(db, wake.id, now + 5001, { runId: "worker", claimToken: "root-claim" })!;
      const execute = vi.fn();
      await expect(resumeOutwardOrdinaryContinuation(db, () => ({ ...session, conversationId: "acp:other" }),
        { execute } as unknown as OutwardAcpPromptExecutor, claim)).rejects.toThrow("Workstream identity changed");
      await expect(resumeOutwardOrdinaryContinuation(db, (id) => repo.get(id),
        { execute } as unknown as OutwardAcpPromptExecutor, claim)).rejects.toThrow("workspace path is invalid");
      expect(execute).not.toHaveBeenCalled();
      expect(listRunContinuations(db, OUTWARD_ACP_SURFACE)[0].successorRunId).toBeUndefined();
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
