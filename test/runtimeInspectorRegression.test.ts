import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { createScheduledRoutine } from "../src/scheduledRoutines.js";
import { renderAgentBridgeInspection } from "../src/runtimeInspector.js";

function utcLocalMinute(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 16);
}

describe("runtime inspector review regressions", () => {
  it("honours BRIDGE_PROJECT_DIR and reports a stale configured routines command as unavailable", () => {
    const dir = join(tmpdir(), `agent-bridge-inspect-root-${process.pid}-${Date.now()}`);
    const dataDir = join(dir, ".data");
    mkdirSync(dataDir, { recursive: true });
    const dbPath = join(dataDir, "bridge.sqlite");
    const db = openDb(dbPath, { serviceId: "test-service", runId: "run-active", lockLeaseMs: 90_000 });
    try {
      db.insertRun("run-active", "chat-1", "codex");
      expect(db.acquireLock("telegram:interactive", "chat-1")).not.toBeNull();

      const view = JSON.parse(renderAgentBridgeInspection(["--json"], {
        BRIDGE_PROJECT_DIR: dir,
        AGENT_BRIDGE_CHAT_KEY: "chat-1",
        AGENT_BRIDGE_SURFACE_IDENTITY: "telegram:interactive",
        AGENT_BRIDGE_RUN_ID: "run-active",
        AGENT_BRIDGE_ROUTINES_COMMAND: "/stale/runtime/bin/agent-bridge-routines",
        HOME: dir,
      }));

      expect(view.execution.status).toBe("ready");
      expect(view.capabilities).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: "scheduled-routines",
          status: "unavailable",
          reasonCode: "routine_command_unavailable",
          interface: "/stale/runtime/bin/agent-bridge-routines",
        }),
      ]));
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not advertise a routines command that exists but is not executable", () => {
    const dir = join(tmpdir(), `agent-bridge-inspect-routines-mode-${process.pid}-${Date.now()}`);
    const binDir = join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    const command = join(binDir, "agent-bridge-routines");
    writeFileSync(command, "#!/usr/bin/env bash\nexit 0\n", "utf8");
    chmodSync(command, 0o644);
    const dbPath = join(dir, "bridge.sqlite");
    const db = openDb(dbPath, { serviceId: "test-service", runId: "run-active", lockLeaseMs: 90_000 });
    try {
      db.insertRun("run-active", "chat-1", "codex");
      expect(db.acquireLock("telegram:interactive", "chat-1")).not.toBeNull();

      const view = JSON.parse(renderAgentBridgeInspection(["--json"], {
        AGENT_BRIDGE_CONTEXT_DB: dbPath,
        AGENT_BRIDGE_CHAT_KEY: "chat-1",
        AGENT_BRIDGE_SURFACE_IDENTITY: "telegram:interactive",
        AGENT_BRIDGE_RUN_ID: "run-active",
        AGENT_BRIDGE_ROUTINES_COMMAND: command,
        HOME: dir,
      }));

      expect(view.capabilities).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: "scheduled-routines",
          status: "unavailable",
          reasonCode: "routine_command_unavailable",
          interface: command,
        }),
      ]));
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("projects a future intended routine occurrence using scheduler-owned due calculation", () => {
    const dir = join(tmpdir(), `agent-bridge-inspect-next-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const dbPath = join(dir, "bridge.sqlite");
    const db = openDb(dbPath, { serviceId: "test-service", runId: "run-active", lockLeaseMs: 90_000 });
    try {
      db.insertRun("run-active", "chat-1", "codex");
      expect(db.acquireLock("telegram:interactive", "chat-1")).not.toBeNull();
      const intended = Date.now() + 24 * 60 * 60 * 1_000;
      createScheduledRoutine(db, {
        id: "future-once",
        name: "Future one-shot",
        instruction: "Do the already-authorised work",
        kind: "companion",
        surfaceIdentity: "telegram:interactive",
        chatKey: "chat-1",
        ownerKey: "owner-1",
        timezone: "UTC",
        schedule: { type: "once", localDateTime: utcLocalMinute(intended) },
        enabled: true,
        createdAt: new Date().toISOString(),
      });

      const view = JSON.parse(renderAgentBridgeInspection(["--json"], {
        AGENT_BRIDGE_CONTEXT_DB: dbPath,
        AGENT_BRIDGE_CHAT_KEY: "chat-1",
        AGENT_BRIDGE_SURFACE_IDENTITY: "telegram:interactive",
        AGENT_BRIDGE_OWNER_KEY: "owner-1",
        AGENT_BRIDGE_RUN_ID: "run-active",
        HOME: dir,
      }));

      expect(view.scheduledRoutines).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: "future-once",
          nextIntendedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
          nextIntendedReasonCode: null,
        }),
      ]));
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a supplied run id that is no longer active instead of claiming readiness", () => {
    const dir = join(tmpdir(), `agent-bridge-inspect-run-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const dbPath = join(dir, "bridge.sqlite");
    const db = openDb(dbPath, { serviceId: "test-service", runId: "other-run", lockLeaseMs: 90_000 });
    try {
      const view = JSON.parse(renderAgentBridgeInspection(["--json"], {
        AGENT_BRIDGE_CONTEXT_DB: dbPath,
        AGENT_BRIDGE_RUN_ID: "missing-run",
        HOME: dir,
      }));
      expect(view.execution).toEqual(expect.objectContaining({ status: "unknown", reasonCode: "current_run_not_active" }));
      expect(view.runtime.service).toEqual({ status: "unknown", reasonCode: "current_run_not_active" });
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not derive current provider readiness from a terminal historical run", () => {
    const dir = join(tmpdir(), `agent-bridge-inspect-historical-run-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const dbPath = join(dir, "bridge.sqlite");
    const db = openDb(dbPath, { serviceId: "test-service", runId: "other-run", lockLeaseMs: 90_000 });
    try {
      db.insertRun("historical-run", "chat-1", "codex");
      db.raw.prepare("UPDATE bridge_runs SET status='done', ended_at=? WHERE run_id=?").run(new Date().toISOString(), "historical-run");

      const view = JSON.parse(renderAgentBridgeInspection(["--json"], {
        AGENT_BRIDGE_CONTEXT_DB: dbPath,
        AGENT_BRIDGE_RUN_ID: "historical-run",
        HOME: dir,
      }));

      expect(view.execution).toEqual(expect.objectContaining({ status: "unknown", reasonCode: "current_run_not_active" }));
      expect(view.providers).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: "codex",
          selected: false,
          availability: "unknown",
          availabilityReasonCode: "not_live_probed",
        }),
      ]));
      expect(view.capabilities).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: "provider-execution",
          status: "unknown",
          reasonCode: "no_current_run_context",
        }),
      ]));
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
