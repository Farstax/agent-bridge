import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import {
  beginExecutionLifecycle,
  completeExecutionLifecycle,
  isAbortRequested,
} from "../src/cli.js";
import { lookupProviderSession } from "../src/providers/sessionRuntime.js";
import { markHandoffRequired, isHandoffRequired } from "../src/handoffState.js";
import { type as eventType } from "../src/events/types.js";
import { openDb } from "../src/db.js";
import {
  BridgeOutwardAcpPromptExecutor,
  OUTWARD_ACP_SURFACE,
} from "../src/acpServer/execution.js";
import { OutwardAcpSessionRepository } from "../src/repositories/outwardAcpSessionRepository.js";

describe("outward ACP cancellation ownership", () => {
  it("does not publish a late successful provider response after Stop wins", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-outward-late-success-"));
    const db = openDb(join(root, "bridge.sqlite"), { databaseRole: "interactive" });
    try {
      const session = new OutwardAcpSessionRepository(db.raw).create({ sessionId: "late-success", conversationId: "acp:late-success", cwd: root });
      markHandoffRequired(db, OUTWARD_ACP_SURFACE, session.conversationId, "codex", "manual_switch");
      let entered!: () => void;
      const ready = new Promise<void>((resolve) => { entered = resolve; });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const updates: unknown[] = [];
      const executor = new BridgeOutwardAcpPromptExecutor({
        db, providerChain: ["codex"] as const, runId: () => "late-success-run",
        createEngine: () => ({ executeSurfaceNeutralTurn: async () => {
          entered();
          await gate;
          return { text: "late response", sessionId: "late-session", nativeSessionMode: "fresh" as const, stopReason: "end_turn" as const };
        } }),
      });
      const execution = executor.execute({ session, prompt: "work", signal: new AbortController().signal, onUpdate: (update) => { updates.push(update); } });
      await ready;
      const cancellation = executor.cancel(session);
      release();
      const [result] = await Promise.all([execution, cancellation]);
      expect(result.stopReason).toBe("cancelled");
      expect(db.getRun("late-success-run").status).toBe("cancelled");
      expect(isHandoffRequired(db, OUTWARD_ACP_SURFACE, session.conversationId, "codex")).toBe(true);
      expect(lookupProviderSession(db, { surfaceIdentity: OUTWARD_ACP_SURFACE, chatKey: session.conversationId }, "codex")).toBeNull();
      expect(db.getRecentConvTurns(session.conversationId, 20, undefined, OUTWARD_ACP_SURFACE).filter((turn) => turn.role === "assistant")).toEqual([]);
      expect(JSON.stringify(updates)).not.toContain("late response");
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("honours Stop while a provider result waits for an update to be delivered", async () => {
    const root = mkdtempSync(join(tmpdir(), "bridge-cancel-update-"));
    const db = openDb(join(root, "bridge.sqlite"), { databaseRole: "interactive" });
    const session = new OutwardAcpSessionRepository(db.raw).create({ sessionId: "update-ws", conversationId: "acp:update-ws", cwd: root });
    let entered!: () => void; const ready = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    const executor = new BridgeOutwardAcpPromptExecutor({ db, providerChain: ["codex"], runId: () => "update-run",
      createEngine: () => ({ executeSurfaceNeutralTurn: async (input) => {
        input.collect(eventType.runStarted({ runId: input.runId, bot: "codex", chatId: String(input.chatId),
          chatKey: input.chatKey, command: "fake", cwd: root, model: null }));
        input.onInterimCommentary?.("progress", "1");
        return { text: "late", sessionId: "late-session", nativeSessionMode: "fresh" as const, stopReason: "end_turn" as const };
      } }) });
    try {
      const execution = executor.execute({ session, prompt: "work", interimCommentary: true, signal: new AbortController().signal,
        onUpdate: async () => { entered(); await gate; } });
      await ready;
      await new Promise<void>((resolve) => setImmediate(resolve));
      const cancellation = executor.cancel(session);
      await new Promise<void>((resolve) => setImmediate(resolve));
      release();
      const [response] = await Promise.all([execution, cancellation]);
      expect(response.stopReason).toBe("cancelled");
      expect(db.getRun("update-run").status).toBe("cancelled");
      expect(lookupProviderSession(db, { surfaceIdentity: OUTWARD_ACP_SURFACE, chatKey: session.conversationId }, "codex")).toBeNull();
    } finally { release(); await executor.shutdown(); db.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it("honours a different process Stop committed immediately before terminal settlement", async () => {
    const root = mkdtempSync(join(tmpdir(), "bridge-cross-stop-"));
    const path = join(root, "bridge.sqlite");
    const db = openDb(path, { databaseRole: "interactive" });
    const other = openDb(path, { databaseRole: "interactive" });
    const session = new OutwardAcpSessionRepository(db.raw).create({ sessionId: "cross-ws", conversationId: "acp:cross-ws", cwd: root });
    let providerReturned = false; let injected = false;
    const original = db.runWithLockFence.bind(db);
    vi.spyOn(db, "runWithLockFence").mockImplementation((lane, operation) => {
      if (providerReturned && !injected) {
        injected = true;
        other.setSetting(`outward-stop-fence:${session.conversationId}`, new Date().toISOString());
      }
      return original(lane, operation);
    });
    const executor = new BridgeOutwardAcpPromptExecutor({ db, providerChain: ["codex"], runId: () => "cross-run",
      createEngine: () => ({ executeSurfaceNeutralTurn: async () => {
        providerReturned = true;
        return { text: "late", sessionId: "late-session", nativeSessionMode: "fresh" as const, stopReason: "end_turn" as const };
      } }) });
    try {
      const response = await executor.execute({ session, prompt: "work", signal: new AbortController().signal, onUpdate: () => undefined });
      expect(injected).toBe(true);
      expect(response.stopReason).toBe("cancelled");
      expect(db.getRun("cross-run").status).toBe("cancelled");
      expect(lookupProviderSession(db, { surfaceIdentity: OUTWARD_ACP_SURFACE, chatKey: session.conversationId }, "codex")).toBeNull();
    } finally { await executor.shutdown(); other.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it("keeps cancellation asserted when it arrives before Bridge lifecycle registration", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-outward-cancel-race-"));
    const db = openDb(join(root, "bridge.sqlite"), { databaseRole: "interactive" });
    try {
      const session = new OutwardAcpSessionRepository(db.raw).create({
        sessionId: "outward-race",
        conversationId: "acp:cancel-race",
        cwd: root,
      });

      let enteredEngine!: () => void;
      const engineEntered = new Promise<void>((resolve) => { enteredEngine = resolve; });
      let releaseLifecycle!: () => void;
      const lifecycleGate = new Promise<void>((resolve) => { releaseLifecycle = resolve; });

      const executor = new BridgeOutwardAcpPromptExecutor({
        db,
        providerChain: ["codex"] as const,
        runId: () => "run-cancel-race",
        createEngine: () => ({
          executeSurfaceNeutralTurn: async (input) => {
            enteredEngine();
            await lifecycleGate;

            const lane = JSON.stringify([OUTWARD_ACP_SURFACE, input.chatKey]);
            const lifecycleToken = beginExecutionLifecycle(lane, input.laneHandle);
            try {
              const deadline = Date.now() + 500;
              while (!isAbortRequested(lane) && Date.now() < deadline) {
                await delay(1);
              }
              expect(isAbortRequested(lane)).toBe(true);
              return {
                text: "cancelled work must not escape",
                sessionId: null,
                stopReason: "cancelled" as const,
              };
            } finally {
              completeExecutionLifecycle(lane, lifecycleToken);
            }
          },
        }),
      });

      const execution = executor.execute({
        session,
        prompt: "cancel during lifecycle handoff",
        signal: new AbortController().signal,
        onUpdate: () => undefined,
      });
      await engineEntered;

      const cancellation = executor.cancel(session);
      releaseLifecycle();

      const [response] = await Promise.all([execution, cancellation]);
      expect(response.stopReason).toBe("cancelled");
      expect(db.getRun("run-cancel-race")?.status).toBe("cancelled");
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("records shutdown cancellation without attributing it to the user", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-outward-shutdown-reason-"));
    const db = openDb(join(root, "bridge.sqlite"), { databaseRole: "interactive" });
    try {
      const session = new OutwardAcpSessionRepository(db.raw).create({
        sessionId: "outward-shutdown", conversationId: "acp:shutdown", cwd: root,
      });
      let entered!: () => void;
      const enteredEngine = new Promise<void>((resolve) => { entered = resolve; });
      let resume!: () => void;
      const settled = new Promise<void>((resolve) => { resume = resolve; });
      const executor = new BridgeOutwardAcpPromptExecutor({
        db,
        providerChain: ["codex"] as const,
        runId: () => "run-shutdown",
        createEngine: () => ({
          executeSurfaceNeutralTurn: async () => {
            entered();
            await settled;
            return { text: "", sessionId: null, stopReason: "cancelled" as const };
          },
        }),
      });
      const running = executor.execute({
        session, prompt: "work", signal: new AbortController().signal, onUpdate: () => undefined,
      });
      await enteredEngine;
      const shutdown = executor.shutdown();
      resume();
      const [result] = await Promise.all([running, shutdown]);
      expect(result.stopReason).toBe("cancelled");
      expect(db.getRun("run-shutdown")).toMatchObject({ status: "cancelled", error: "shutdown" });
      expect(executor.status(session).lastRun).toMatchObject({ interrupted: true, error: "Run interrupted by service shutdown." });
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
