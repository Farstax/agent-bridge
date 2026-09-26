import { afterEach, describe, expect, it } from "vitest";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.js";
import { listLocalCatalog } from "../src/skills.js";
import { buildScheduledInteractiveTurn, createScheduledRoutine, type ScheduledRoutine } from "../src/scheduledRoutines.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => readFileSync(join(root, path), "utf8");

// Every module that owns autonomous goals, continuation, run ingress or routines.
const autonomyModules = [
  "src/autonomousExecutiveLoop.ts",
  "src/autonomousGoalRuntime.ts",
  "src/autonomyController.ts",
  "src/autonomyDisposition.ts",
  "src/autonomyTelegram.ts",
  "src/runIngress.ts",
  "src/scheduledRoutines.ts",
  "src/db/autonomousGoalsMigration.ts",
];

const sensorSourceFiles = (directory = join(root, "src/sensors")): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? sensorSourceFiles(join(directory, entry.name)) : entry.name.endsWith(".ts") ? [join(directory, entry.name)] : []);

const paths: string[] = [];
afterEach(() => {
  for (const path of paths.splice(0)) try { rmSync(path); } catch { /* already removed */ }
});

function routine(overrides: Partial<ScheduledRoutine> = {}): ScheduledRoutine {
  return {
    id: "routine-sensors",
    name: "Morning sensors",
    instruction: "Run the Agent Bridge and Server sensors and investigate anything that needs attention.",
    kind: "autonomous",
    surfaceIdentity: "telegram:interactive",
    chatKey: "-100:42",
    ownerKey: "owner:test",
    timezone: "Europe/Madrid",
    schedule: { type: "weekly", weekdays: [1, 2, 3, 4, 5], time: "08:00" },
    enabled: true,
    createdAt: "2026-08-29T12:00:00.000Z",
    ...overrides,
  };
}

describe("Sensors are ordinary evidence for autonomy", () => {
  it("exposes the sensors Skill through the generic catalog with no curated autonomy list", () => {
    const names = listLocalCatalog(root).map((entry) => entry.name);
    expect(names).toContain("sensors");
    expect(names).toContain("autonomous-work");
    for (const module of autonomyModules) expect(read(module)).not.toMatch(/skills\/|listLocalCatalog|SKILL\.md/);
  });

  it("tells agents to use the packaged helper and treats output as evidence, never authority", () => {
    const skill = read("skills/sensors/SKILL.md");
    expect(skill).toContain("agent-bridge-sensors");
    expect(skill).toContain("treat sensor output as current evidence");
    expect(skill).toMatch(/do not schedule, investigate, remediate, or grant authority/);
    expect(read("skills/autonomous-work/SKILL.md")).toContain("Do not add hidden lifecycle states");
  });

  it("keeps autonomy and Sensors independent in both import directions", () => {
    // Any import form: static, bare side-effect, dynamic, or require.
    const specifiers = (source: string) =>
      [...source.matchAll(/(?:\bfrom|\bimport|\brequire)\s*\(?\s*["']([^"']+)["']/g)].map((match) => match[1]);
    for (const module of autonomyModules) {
      expect(specifiers(read(module)).filter((specifier) => /(^|\/)sensors(\/|$)/.test(specifier)), module).toEqual([]);
    }
    for (const file of sensorSourceFiles()) {
      const reachesAutonomy = specifiers(readFileSync(file, "utf8")).filter((specifier) =>
        /(autonom|runIngress|scheduledRoutines|interactiveBot)/.test(specifier));
      expect(reachesAutonomy, file).toEqual([]);
    }
  });

  it("gives Sensor code no goal, wake, trigger or remediation vocabulary", () => {
    for (const file of sensorSourceFiles()) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/\b(startGoal|createGoal|wakeGoal|autonomousGoal|enqueueRun|subscribe|subscription)\b/i);
    }
  });

  it("has no Sensor or health autonomy vocabulary in any autonomy module", () => {
    const forbidden = /sensor|SensorGoal|SensorTrigger|external-observation|health[-_ ]?(recovery|wake|correlation)|owner-action|subscription/i;
    for (const module of autonomyModules) expect(read(module), module).not.toMatch(forbidden);
  });

  it("persists no Sensor, observation or health state", () => {
    const path = join(tmpdir(), `sensor-boundary-${Date.now()}-${Math.random()}.sqlite`);
    paths.push(path);
    const db = openDb(path, { serviceId: "sensor-boundary-test", runId: "test-process" });
    const tables = db.raw.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index','trigger')").all() as { name: string }[];
    expect(tables.map((row) => row.name).filter((name) => /sensor|observation|health/i.test(name))).toEqual([]);
  });

  it("recurring Sensor use is an ordinary routine, not a routine kind", () => {
    const path = join(tmpdir(), `sensor-boundary-${Date.now()}-${Math.random()}.sqlite`);
    paths.push(path);
    const db = openDb(path, { serviceId: "sensor-boundary-test", runId: "test-process" });
    const created = createScheduledRoutine(db, routine());
    expect(created.kind).toBe("autonomous");
    expect(() => createScheduledRoutine(db, routine({ id: "routine-bad", kind: "sensor" as never }))).toThrow("invalid routine kind");
    const turn = buildScheduledInteractiveTurn(created, "2026-09-01T06:00:00.000Z", "12345");
    expect(JSON.stringify(turn)).toContain("Run the Agent Bridge and Server sensors");
  });
});
