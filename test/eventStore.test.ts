/**
 * Phase 3 cleanup: EventStore extracted from BridgeEngine._createEventContext().
 * Tests written before implementation (red state).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
});