import { afterEach, describe, expect, it } from "vitest";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../src/db.js";
import { SensorRegistry } from "../src/sensors/registry.js";
import { buildSensorsKeyboard, formatSensorReport, isSensorsCommand, parseSensorCallback } from "../src/sensors/telegram.js";

const paths: string[] = [];
const temporary = (name: string) => {
  const path = join(tmpdir(), `${name}-${Date.now()}-${Math.random()}`);
  paths.push(path);
  return path;
};

afterEach(() => {
  for (const path of paths.splice(0)) try { rmSync(path); } catch { /* already gone */ }
});

describe("sensors", () => {
  it("always exposes built-in Agent Bridge and Server sensors", () => {
    const dbPath = temporary("sensors-db.sqlite");
    const db = openDb(dbPath, { serviceId: "sensor-test", runId: "sensor-test" });
    const registry = new SensorRegistry({ db, dbPath, env: {} });
    expect(registry.list()).toEqual([
      { id: "agent-bridge", label: "Agent Bridge health" },
      { id: "server", label: "Server health" },
    ]);
    db.close();
  });

  it("discovers arbitrary external sensors without Telegram-specific code", async () => {
    const dbPath = temporary("sensors-ext.sqlite");
    const db = openDb(dbPath, { serviceId: "sensor-test", runId: "sensor-test" });
    const configPath = temporary("sensors.json");
    const report = JSON.stringify({
      status: "green",
      checks: [{ name: "queue", status: "green", message: "clear", value: 0 }],
      summary: "nominal",
      timestamp: "2026-09-18T10:00:00Z",
    });
    writeFileSync(configPath, JSON.stringify({
      external: [
        { id: "content-crawler", label: "Content Crawler health", command: process.execPath, args: ["-e", `process.stdout.write(${JSON.stringify(report)})`] },
        { id: "example", label: "Example health", command: process.execPath, args: ["-e", `process.stdout.write(${JSON.stringify(report)})`] },
      ],
    }));
    const registry = new SensorRegistry({ db, dbPath, env: { AGENT_BRIDGE_SENSOR_CONFIG: configPath } });
    expect(registry.list().map((sensor) => sensor.id)).toEqual(["agent-bridge", "server", "content-crawler", "example"]);
    await expect(registry.run("content-crawler")).resolves.toMatchObject({
      sensorId: "content-crawler",
      label: "Content Crawler health",
      status: "green",
    });
    db.close();
  });

  it("fails clearly for invalid external configuration", () => {
    const configPath = temporary("bad-sensors.json");
    writeFileSync(configPath, JSON.stringify({ external: [{ id: "bad id", label: "Bad", command: "/bin/true" }] }));
    expect(() => new SensorRegistry({ env: { AGENT_BRIDGE_SENSOR_CONFIG: configPath } })).toThrow(/invalid.*sensor id/);
  });

  it("turns malformed external output into a bounded red observation", async () => {
    const configPath = temporary("malformed-sensors.json");
    writeFileSync(configPath, JSON.stringify({
      external: [{ id: "broken", label: "Broken", command: process.execPath, args: ["-e", "process.stdout.write('not-json')"] }],
    }));
    const registry = new SensorRegistry({ env: { AGENT_BRIDGE_SENSOR_CONFIG: configPath } });
    await expect(registry.run("broken")).resolves.toMatchObject({ sensorId: "broken", status: "red" });
  });

  it("formats a bounded sensor report without running host probes", () => {
    const report = {
      sensorId: "server",
      label: "Server health",
      status: "amber" as const,
      checks: [{ name: "disk", status: "amber" as const, message: "Disk usage elevated" }],
      summary: "Issues: disk",
      timestamp: "2026-09-18T10:00:00Z",
    };
    expect(formatSensorReport(report)).toContain("Overall: Amber");
    expect(formatSensorReport(report)).toContain("disk: Disk usage elevated");
  });

  it("builds the Telegram sensor menu and parses only sensor callbacks", () => {
    expect(isSensorsCommand("/sensors")).toBe(true);
    expect(isSensorsCommand("/sensors@BridgeBot", "bridgebot")).toBe(true);
    const keyboard = buildSensorsKeyboard([{ id: "server", label: "Server health" }]);
    expect(keyboard.inline_keyboard.flat().map((button) => button.callback_data)).toEqual(["sensor:server", "sensor:all"]);
    expect(parseSensorCallback("sensor:server")).toBe("server");
    expect(parseSensorCallback("cli:codex")).toBeNull();
  });
});
