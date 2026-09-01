import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { openDb } from "../src/db.js";
import { applyMigrations } from "../src/db/schema.js";
import { claimScheduledRoutineOccurrence, createScheduledRoutine } from "../src/scheduledRoutines.js";
import { createAutonomousGoal } from "../src/autonomousGoalRuntime.js";
import { HealthReportStore } from "../src/health/reports.js";
import {
  MAX_INSPECTION_OUTPUT_CHARS,
  renderAgentBridgeInspection,
} from "../src/runtimeInspector.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "agent-bridge-inspect-"));
  const path = join(dir, "bridge.sqlite");
  const healthPath = join(dir, "health.sqlite");
  const db = openDb(path, { serviceId: "test-service", runId: "run-active", lockLeaseMs: 90_000 });
  const healthDb = new Database(healthPath);
  applyMigrations(healthDb, undefined, "health");
  return { dir, path, healthPath, db, healthDb };
}

describe("runtime inspector", () => {
  it("projects representative runtime state without exposing secret-bearing fields", () => {
    const { dir, path, healthPath, db, healthDb } = fixture();
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
      const routineOccurrence = new Date().toISOString();
      expect(claimScheduledRoutineOccurrence(db, "routine-1", routineOccurrence)).toBe(true);
      db.insertRun("run-routine", "chat-1", "codex");
      createAutonomousGoal(db, {
        goalId: "goal-1",
        prompt: "private objective ghp_supersecret",
        constraints: ["private constraint"],
        bot: "codex",
        maxCycles: 4,
      });
      new HealthReportStore(healthDb).saveReport({
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
        HEALTH_MONITOR_ENABLED: "true",
        HEALTH_SERVER_MONITOR_ENABLED: "0",
        HEALTH_DB_PATH: healthPath,
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
        expect.objectContaining({
          id: "routine-1",
          name: "Daily status",
          kind: "companion",
          recentOccurrence: expect.objectContaining({
            runId: "run-routine",
            runStatus: "running",
            provider: "codex",
            reasonCode: null,
          }),
        }),
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
      healthDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed when more than one Run could match a scheduled occurrence", () => {
    const { dir, path, db, healthDb } = fixture();
    try {
      createScheduledRoutine(db, {
        id: "routine-ambiguous",
        name: "Ambiguous routine",
        instruction: "bounded instruction",
        kind: "companion",
        surfaceIdentity: "telegram:interactive",
        chatKey: "chat-ambiguous",
        ownerKey: "owner-1",
        timezone: "UTC",
        schedule: { type: "weekly", weekdays: [1], time: "09:00" },
        enabled: true,
        createdAt: new Date().toISOString(),
      });
      const intendedAt = new Date().toISOString();
      expect(claimScheduledRoutineOccurrence(db, "routine-ambiguous", intendedAt)).toBe(true);
      db.insertRun("run-a", "chat-ambiguous", "codex");
      db.insertRun("run-b", "chat-ambiguous", "claude");

      const view = JSON.parse(renderAgentBridgeInspection(["--json"], {
        AGENT_BRIDGE_CONTEXT_DB: path,
        AGENT_BRIDGE_CHAT_KEY: "chat-ambiguous",
        AGENT_BRIDGE_SURFACE_IDENTITY: "telegram:interactive",
        AGENT_BRIDGE_OWNER_KEY: "owner-1",
        HOME: dir,
      }));
      expect(view.scheduledRoutines[0].recentOccurrence).toEqual(expect.objectContaining({
        runId: null,
        reasonCode: "run_correlation_ambiguous",
      }));
    } finally {
      db.close();
      healthDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses unknown/unavailable states instead of inventing missing or stale evidence", () => {
    const { dir, path, healthPath, db, healthDb } = fixture();
    try {
      new HealthReportStore(healthDb).saveReport({
        pluginName: "self",
        status: "green",
        checks: [],
        summary: "old",
        timestamp: new Date(0).toISOString(),
      });
      healthDb.prepare("UPDATE health_plugin_reports SET saved_at = 1 WHERE plugin_name = 'self'").run();
      db.close();

      const view = JSON.parse(renderAgentBridgeInspection(["--json"], {
        AGENT_BRIDGE_CONTEXT_DB: path,
        HEALTH_MONITOR_ENABLED: "true",
        HEALTH_SERVER_MONITOR_ENABLED: "0",
        HEALTH_DB_PATH: healthPath,
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
      try { healthDb.close(); } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("projects the exact deployed commit from the active release manifest", () => {
    const { dir, path, db, healthDb } = fixture();
    try {
      const deployed = "c405eb15d742bff21c00f8747d60719b2ed0416b";
      const staleHint = "1111111111111111111111111111111111111111";
      writeFileSync(join(dir, "manifest.json"), JSON.stringify({ schema_version: 1, commit: deployed }));

      const env = {
        AGENT_BRIDGE_CONTEXT_DB: path,
        BRIDGE_PROJECT_DIR: dir,
        AGENT_BRIDGE_COMMIT: staleHint,
        HOME: dir,
      };
      const full = JSON.parse(renderAgentBridgeInspection(["--json"], env));
      const capabilities = JSON.parse(renderAgentBridgeInspection(["capabilities", "--json"], env));
      expect(full.runtime.commit).toBe(deployed);
      expect(capabilities.runtime.commit).toBe(deployed);

      writeFileSync(join(dir, "manifest.json"), JSON.stringify({ schema_version: 1, commit: "not-a-sha" }));
      expect(JSON.parse(renderAgentBridgeInspection(["--json"], env)).runtime.commit).toBe(staleHint);

      expect(JSON.parse(renderAgentBridgeInspection(["--json"], {
        AGENT_BRIDGE_CONTEXT_DB: path,
        BRIDGE_PROJECT_DIR: dir,
        HOME: dir,
      })).runtime.commit).toBeNull();
    } finally {
      db.close();
      healthDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("supports a capability-only bounded JSON projection", () => {
    const { dir, path, db, healthDb } = fixture();
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
      healthDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
