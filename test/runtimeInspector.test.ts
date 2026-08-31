import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { openDb } from "../src/db.js";
import { createScheduledRoutine } from "../src/scheduledRoutines.js";
import { createAutonomousGoal } from "../src/autonomousGoalRuntime.js";
import { HealthReportStore } from "../src/health/reports.js";
import {
  MAX_INSPECTION_OUTPUT_CHARS,
  renderAgentBridgeInspection,
} from "../src/runtimeInspector.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "agent-bridge-inspect-"));
  const path = join(dir, "bridge.sqlite");
  const db = openDb(path, { serviceId: "test-service", runId: "run-active", lockLeaseMs: 90_000 });
  return { dir, path, db };
}

describe("runtime inspector", () => {
  it("projects representative runtime state without exposing secret-bearing fields", () => {
    const { dir, path, db } = fixture();
    try {
      db.insertRun("run-active", "chat-1", "codex");
      db.insertRun("run-failed", "chat-1", "claude");
      db.updateRunFailed("run-failed", "github token ghp_supersecret must never escape");
      db.setSession("chat-1", "codex", "secret-session-id");
      expect(db.acquireLock("telegram:interactive", "chat-1")).not.toBeNull();
      createScheduledRoutine(db, {
        id: "routine-1",
        name: "Daily status",
        instruction: "private routine instruction ghp_supersecret",
        kind: "companion",
        surfaceIdentity: "telegram:interactive",
        chatKey: "chat-1",
        ownerKey: "owner-1",
        timezone: "UTC",
        schedule: { type: "weekly", weekdays: [1], time: "09:00" },
        enabled: true,
        createdAt: new Date().toISOString(),
      });
      createAutonomousGoal(db, {
        goalId: "goal-1",
        prompt: "private objective ghp_supersecret",
        constraints: ["private constraint"],
        bot: "codex",
        maxCycles: 4,
      });
      new HealthReportStore(db.raw).saveReport({
        pluginName: "self",
        status: "amber",
        checks: [{ name: "runtime", status: "amber", message: "private health detail ghp_supersecret" }],
        summary: "private health summary ghp_supersecret",
        timestamp: new Date().toISOString(),
      });

      const text = renderAgentBridgeInspection(["--json"], {
        AGENT_BRIDGE_CONTEXT_DB: path,
        AGENT_BRIDGE_CHAT_KEY: "chat-1",
        AGENT_BRIDGE_SURFACE_IDENTITY: "telegram:interactive",
        AGENT_BRIDGE_OWNER_KEY: "owner-1",
        AGENT_BRIDGE_RUN_ID: "run-active",
        AGENT_BRIDGE_ROUTINES_COMMAND: "/runtime/bin/agent-bridge-routines",
        HEALTH_MONITOR_ENABLED: "true",
        HEALTH_SERVER_MONITOR_ENABLED: "0",
        HOME: dir,
      });
      const view = JSON.parse(text);

      expect(view.schemaVersion).toBe(1);
      expect(view.runtime.database.status).toBe("ready");
      expect(view.execution.activeRuns).toEqual(expect.arrayContaining([
        expect.objectContaining({ runId: "run-active", provider: "codex", status: "running" }),
      ]));
      expect(view.execution.recentTerminal).toEqual(expect.arrayContaining([
        expect.objectContaining({ runId: "run-failed", provider: "claude", status: "failed" }),
      ]));
      expect(view.sessions.providers).toEqual(expect.arrayContaining([
        expect.objectContaining({ provider: "codex", exists: true }),
      ]));
      expect(view.scheduledRoutines).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "routine-1", name: "Daily status", kind: "companion" }),
      ]));
      expect(view.autonomy.goals).toEqual(expect.arrayContaining([
        expect.objectContaining({ goalId: "goal-1", provider: "codex", status: "active", maxCycles: 4 }),
      ]));
      expect(view.health.status).toBe("amber");
      expect(view.capabilities).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "scheduled-routines", status: "ready" }),
        expect.objectContaining({ id: "autonomous-work", status: "ready" }),
      ]));
      expect(text.length).toBeLessThanOrEqual(MAX_INSPECTION_OUTPUT_CHARS);
      for (const secret of ["ghp_supersecret", "secret-session-id", "private routine instruction", "private objective", "private health detail"]) {
        expect(text).not.toContain(secret);
      }
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses unknown/unavailable states instead of inventing missing or stale evidence", () => {
    const { dir, path, db } = fixture();
    try {
      new HealthReportStore(db.raw).saveReport({
        pluginName: "self",
        status: "green",
        checks: [],
        summary: "old",
        timestamp: new Date(0).toISOString(),
      });
      db.raw.prepare("UPDATE health_plugin_reports SET saved_at = 1 WHERE plugin_name = 'self'").run();
      db.close();

      const view = JSON.parse(renderAgentBridgeInspection(["--json"], {
        AGENT_BRIDGE_CONTEXT_DB: path,
        HEALTH_MONITOR_ENABLED: "true",
        HEALTH_SERVER_MONITOR_ENABLED: "0",
        HOME: dir,
      }));

      expect(view.providers.every((provider: { availability: string }) => provider.availability === "unknown")).toBe(true);
      expect(view.sessions.status).toBe("unknown");
      expect(view.health.status).toBeNull();
      expect(view.health.stalePluginNames).toContain("self");
      expect(view.capabilities).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "retained-context", status: "unavailable", reasonCode: "conversation_scope_unavailable" }),
      ]));
    } finally {
      try { db.close(); } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("supports a capability-only bounded JSON projection", () => {
    const { dir, path, db } = fixture();
    try {
      const view = JSON.parse(renderAgentBridgeInspection(["capabilities", "--json"], {
        AGENT_BRIDGE_CONTEXT_DB: path,
        HOME: dir,
      }));
      expect(view).toEqual(expect.objectContaining({ schemaVersion: 1, capabilities: expect.any(Array) }));
      expect(view.execution).toBeUndefined();
      expect(JSON.stringify(view).length).toBeLessThanOrEqual(MAX_INSPECTION_OUTPUT_CHARS);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
