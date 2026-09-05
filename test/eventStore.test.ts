/**
 * Phase 3 cleanup: EventStore extracted from BridgeEngine._createEventContext().
 * Tests written before implementation (red state).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { openDb } from "../src/db.js";

describe("EventStore", () => {
  let db: ReturnType<typeof openDb>;
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `event-store-test-${Date.now()}.sqlite`);
    db = openDb(dbPath);
  });

  afterEach(() => {
    db.close();
    try { rmSync(dbPath); } catch {}
  });

  it("collect(run.started) inserts the run row and start event", async () => {
    const { EventStore } = await import("../src/events/store.js");
    const store = new EventStore(db);
    const { type } = await import("../src/events/types.js");

    const startedEvt = type.runStarted({ runId: "r-1", bot: "claude", chatId: "100", chatKey: "100", command: "claude", cwd: "/", model: null });
    store.collect(startedEvt);

    const run = db.getRun("r-1");
    expect(run).toBeDefined();
    expect(run.run_id).toBe("r-1");
    expect(run.status).toBe("running");

    const events = db.getEventsForRun("r-1");
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("run.started");
  });

  it("persists a topic-qualified chat key for run.started recovery", async () => {
    const { EventStore } = await import("../src/events/store.js");
    const store = new EventStore(db);
    const { type } = await import("../src/events/types.js");

    store.collect(type.runStarted({
      runId: "r-topic-start",
      bot: "claude",
      chatId: "-1004366290625",
      chatKey: "-1004366290625:1458",
      threadId: "1458",
      command: "claude",
      cwd: "/",
      model: null,
    }));

    expect(db.getRun("r-topic-start").chat_id).toBe("-1004366290625:1458");
  });

  it("persists a topic-qualified chat key when a terminal event creates the run", async () => {
    const { EventStore } = await import("../src/events/store.js");
    const store = new EventStore(db);
    const { type } = await import("../src/events/types.js");

    store.collect(type.runFailed({
      runId: "r-topic-terminal",
      bot: "claude",
      chatId: "-1004366290625",
      chatKey: "-1004366290625:3",
      threadId: "3",
      error: "interrupted",
      category: "cli",
    }));

    expect(db.getRun("r-topic-terminal").chat_id).toBe("-1004366290625:3");
  });

  it("collect(run.failed) persists the run and failed event, updates status", async () => {
    const { EventStore } = await import("../src/events/store.js");
    const store = new EventStore(db);
    const { type } = await import("../src/events/types.js");

    const startEvt = type.runStarted({ runId: "r-2", bot: "claude", chatId: "100", chatKey: "100", command: "claude", cwd: "/", model: null });
    const failEvt = type.runFailed({ runId: "r-2", bot: "claude", chatId: "100", chatKey: "100", error: "timeout", category: "timeout" });
    store.collect(startEvt);
    store.collect(failEvt);

    const run = db.getRun("r-2");
    expect(run.status).toBe("failed");
    expect(run.error).toBe("timeout");
  });

  it("collect(run.cancelled) updates status to cancelled", async () => {
    const { EventStore } = await import("../src/events/store.js");
    const store = new EventStore(db);
    const { type } = await import("../src/events/types.js");

    store.collect(type.runStarted({ runId: "r-3", bot: "claude", chatId: "100", chatKey: "100", command: "claude", cwd: "/", model: null }));
    store.collect(type.runCancelled({ runId: "r-3", bot: "claude", chatId: "100", chatKey: "100", reason: "user" }));

    expect(db.getRun("r-3").status).toBe("cancelled");
  });

  it("finalize() persists a deferred run.completed event", async () => {
    const { EventStore } = await import("../src/events/store.js");
    const store = new EventStore(db);
    const { type } = await import("../src/events/types.js");

    store.collect(type.runStarted({ runId: "r-4", bot: "claude", chatId: "100", chatKey: "100", command: "claude", cwd: "/", model: null }));
    store.queueCompleted(type.runCompleted({ runId: "r-4", bot: "claude", chatId: "100", chatKey: "100", text: "done", sessionId: "s-1" }));
    store.finalize();

    const run = db.getRun("r-4");
    expect(run.status).toBe("done");
    expect(run.final_text_preview).toBe("done");
    expect(run.session_id).toBe("s-1");
  });

  it("finalize() is a no-op when queueCompleted was never called", async () => {
    const { EventStore } = await import("../src/events/store.js");
    const store = new EventStore(db);
    // Should not throw
    expect(() => store.finalize()).not.toThrow();
  });

  it("collect(run.started) is idempotent — second call is a no-op", async () => {
    const { EventStore } = await import("../src/events/store.js");
    const store = new EventStore(db);
    const { type } = await import("../src/events/types.js");

    const e = type.runStarted({ runId: "r-5", bot: "claude", chatId: "100", chatKey: "100", command: "claude", cwd: "/", model: null });
    store.collect(e);
    store.collect(e); // second call — run already inserted

    expect(db.getEventsForRun("r-5").length).toBe(1);
  });

  it("errors in persistence are swallowed and do not propagate", async () => {
    const { EventStore } = await import("../src/events/store.js");
    const { type } = await import("../src/events/types.js");

    // Close DB so all writes fail
    db.close();
    const store = new EventStore(db);
    const e = type.runStarted({ runId: "r-6", bot: "claude", chatId: "100", chatKey: "100", command: "claude", cwd: "/", model: null });

    expect(() => store.collect(e)).not.toThrow();

    // Reopen to allow cleanup
    db = openDb(dbPath);
  });

  it("collect() warns with the run/chat identifiers (not content) instead of silently dropping the write", async () => {
    const { EventStore } = await import("../src/events/store.js");
    const { type } = await import("../src/events/types.js");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    db.close();
    const store = new EventStore(db);
    const e = type.runStarted({
      runId: "r-topic-swallow",
      bot: "antigravity",
      chatId: "-1004366290625",
      chatKey: "-1004366290625:1458",
      command: "agy",
      cwd: "/",
      model: null,
    });

    store.collect(e);

    expect(warn).toHaveBeenCalledTimes(1);
    const [message] = warn.mock.calls[0];
    expect(message).toContain("r-topic-swallow");
    expect(message).toContain("-1004366290625:1458");

    warn.mockRestore();
    db = openDb(dbPath);
  });

  it("finalize() warns with the run/chat identifiers (not the response text) instead of silently dropping the write", async () => {
    const { EventStore } = await import("../src/events/store.js");
    const { type } = await import("../src/events/types.js");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const store = new EventStore(db);
    store.collect(type.runStarted({
      runId: "r-topic-swallow-finalize",
      bot: "antigravity",
      chatId: "-1004366290625",
      chatKey: "-1004366290625:1458",
      command: "agy",
      cwd: "/",
      model: null,
    }));

    db.close();
    store.queueCompleted(type.runCompleted({
      runId: "r-topic-swallow-finalize",
      bot: "antigravity",
      chatId: "-1004366290625",
      chatKey: "-1004366290625:1458",
      text: "a secret answer that must never reach logs",
      sessionId: null,
    }));
    store.finalize();

    expect(warn).toHaveBeenCalledTimes(1);
    const [message] = warn.mock.calls[0];
    expect(message).toContain("r-topic-swallow-finalize");
    expect(message).toContain("-1004366290625:1458");
    expect(message).not.toContain("secret answer");

    warn.mockRestore();
    db = openDb(dbPath);
  });

  describe("atomicity: run.started and terminal writes cannot land partially", () => {
    it("rolls back insertRun when its paired bridge_events insert fails, instead of leaving an eventless 'running' row", async () => {
      const { EventStore } = await import("../src/events/store.js");
      const { type } = await import("../src/events/types.js");
      const store = new EventStore(db);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      const insertEventSpy = vi.spyOn(db, "insertEvent").mockImplementationOnce(() => {
        throw new Error("simulated write failure between insertRun and insertEvent");
      });

      store.collect(type.runStarted({
        runId: "r-atomic-start",
        bot: "antigravity",
        chatId: "-1004366290625",
        chatKey: "-1004366290625:1458",
        command: "agy",
        cwd: "/",
        model: null,
      }));

      // Pre-fix behaviour: insertRun() already committed on its own before
      // insertEvent() threw, leaving a durable 'running' row with no events.
      expect(db.getRun("r-atomic-start")).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);

      insertEventSpy.mockRestore();
      warn.mockRestore();
    });

    it("recovers cleanly on retry after a rolled-back run.started — no leftover row blocks re-insertion", async () => {
      const { EventStore } = await import("../src/events/store.js");
      const { type } = await import("../src/events/types.js");
      const store = new EventStore(db);
      vi.spyOn(console, "warn").mockImplementation(() => {});

      const insertEventSpy = vi.spyOn(db, "insertEvent").mockImplementationOnce(() => {
        throw new Error("simulated write failure");
      });
      const startedEvt = type.runStarted({
        runId: "r-atomic-retry",
        bot: "antigravity",
        chatId: "-1004366290625",
        chatKey: "-1004366290625:1458",
        command: "agy",
        cwd: "/",
        model: null,
      });
      store.collect(startedEvt);
      expect(db.getRun("r-atomic-retry")).toBeUndefined();

      insertEventSpy.mockRestore();
      // A fresh EventStore for the retry, exactly as the engine constructs
      // one per execution attempt — this must not hit a PRIMARY KEY
      // conflict from a half-written row the first attempt left behind.
      const retryStore = new EventStore(db);
      retryStore.collect(startedEvt);

      const run = db.getRun("r-atomic-retry");
      expect(run).toMatchObject({ run_id: "r-atomic-retry", status: "running" });
      expect(db.getEventsForRun("r-atomic-retry")).toHaveLength(1);

      vi.restoreAllMocks();
    });

    it("rolls back the terminal bridge_events insert when the bridge_runs status update throws", async () => {
      const { EventStore } = await import("../src/events/store.js");
      const { type } = await import("../src/events/types.js");
      const store = new EventStore(db);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      store.collect(type.runStarted({
        runId: "r-atomic-terminal",
        bot: "antigravity",
        chatId: "-1004366290625",
        chatKey: "-1004366290625:1458",
        command: "agy",
        cwd: "/",
        model: null,
      }));
      expect(db.getEventsForRun("r-atomic-terminal")).toHaveLength(1);

      const updateSpy = vi.spyOn(db, "updateRunCompleted").mockImplementationOnce(() => {
        throw new Error("simulated status-update failure after the event insert");
      });

      store.queueCompleted(type.runCompleted({
        runId: "r-atomic-terminal",
        bot: "antigravity",
        chatId: "-1004366290625",
        chatKey: "-1004366290625:1458",
        text: "answer",
        sessionId: null,
      }));
      store.finalize();

      expect(db.getEventsForRun("r-atomic-terminal")).toHaveLength(1);
      expect(db.getRun("r-atomic-terminal")).toMatchObject({ status: "running" });
      expect(warn).toHaveBeenCalledTimes(1);

      updateSpy.mockRestore();
      warn.mockRestore();
    });

    it("rolls back the terminal bridge_events insert when the compare-and-swap transition returns false", async () => {
      const { EventStore } = await import("../src/events/store.js");
      const { type } = await import("../src/events/types.js");
      const store = new EventStore(db);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      store.collect(type.runStarted({
        runId: "r-terminal-cas-lost",
        bot: "antigravity",
        chatId: "-1004366290625",
        chatKey: "-1004366290625:1458",
        command: "agy",
        cwd: "/",
        model: null,
      }));
      expect(db.getEventsForRun("r-terminal-cas-lost")).toHaveLength(1);

      const updateSpy = vi.spyOn(db, "updateRunCompleted").mockReturnValueOnce(false);
      store.queueCompleted(type.runCompleted({
        runId: "r-terminal-cas-lost",
        bot: "antigravity",
        chatId: "-1004366290625",
        chatKey: "-1004366290625:1458",
        text: "answer that must not get a terminal event",
        sessionId: null,
      }));
      store.finalize();

      expect(db.getEventsForRun("r-terminal-cas-lost")).toHaveLength(1);
      expect(db.getRun("r-terminal-cas-lost")).toMatchObject({ status: "running" });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("terminal run transition rejected");

      updateSpy.mockRestore();
      warn.mockRestore();
    });
  });
});
