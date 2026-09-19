import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.js";
import { SensorRegistry } from "../src/sensors/registry.js";
import { buildSensorsKeyboard, formatSensorReport, formatSensorReports, handleSensorCallback, isSensorsCommand, parseSensorCallback } from "../src/sensors/telegram.js";
import { normalizeSensorReport } from "../src/sensors/report.js";
import { readAptUpdateStatus, ServerSensor } from "../src/sensors/server.js";
import { AgentBridgeSensor } from "../src/sensors/agentBridge.js";

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

  it("returns bounded structured observations from both built-in Sensors", async () => {
    const dbPath = temporary("built-in-sensors.sqlite");
    const db = openDb(dbPath, { serviceId: "sensor-test", runId: "sensor-test" });
    const bridge = await new AgentBridgeSensor(db, dbPath).check();
    const server = await new ServerSensor().check();

    for (const report of [bridge, server]) {
      expect(["green", "amber", "red"]).toContain(report.status);
      expect(report.checks.length).toBeLessThanOrEqual(32);
      expect(report.checks.every((check) => check.name.length <= 120 && check.message.length <= 500)).toBe(true);
      expect(report.summary.length).toBeLessThanOrEqual(500);
    }
    expect(bridge.checks.find((check) => check.name === "db-read")?.status).toBe("green");
    db.close();
  }, 10_000);

  it("does not write Sensor or health history while observing the interactive DB", async () => {
    const dbPath = temporary("sensor-readonly.sqlite");
    const db = openDb(dbPath, { serviceId: "sensor-test", runId: "sensor-test" });
    const before = (db.raw.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    await new SensorRegistry({ db, dbPath, env: {} }).run("agent-bridge");
    const after = (db.raw.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    expect(after).toBe(before);
    expect(db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='health_plugin_reports'").get()).toBeUndefined();
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
    const all = await registry.runAll();
    expect(all.map((report) => report.sensorId)).toEqual(["agent-bridge", "server", "content-crawler", "example"]);
    expect(new Set(all.map((report) => report.sensorId)).size).toBe(all.length);
    db.close();
  });

  it("fails clearly for invalid external configuration", () => {
    const configPath = temporary("bad-sensors.json");
    writeFileSync(configPath, JSON.stringify({ external: [{ id: "bad id", label: "Bad", command: "/bin/true" }] }));
    expect(() => new SensorRegistry({ env: { AGENT_BRIDGE_SENSOR_CONFIG: configPath } })).toThrow(/invalid.*sensor id/);
  });

  it("rejects external Sensors that collide with built-in IDs", () => {
    const configPath = temporary("reserved-sensors.json");
    writeFileSync(configPath, JSON.stringify({
      external: [{ id: "server", label: "Spoofed server", command: "/bin/true" }],
    }));
    expect(() => new SensorRegistry({ env: { AGENT_BRIDGE_SENSOR_CONFIG: configPath } })).toThrow(/reserved sensor id/);
  });

  it("does not expose stderr from a failing external Sensor", async () => {
    const configPath = temporary("stderr-sensors.json");
    writeFileSync(configPath, JSON.stringify({
      external: [{
        id: "failing",
        label: "Failing",
        command: process.execPath,
        args: ["-e", "process.stderr.write('secret diagnostic'); process.exit(7)"],
      }],
    }));
    const registry = new SensorRegistry({ env: { AGENT_BRIDGE_SENSOR_CONFIG: configPath } });
    const report = await registry.run("failing");
    expect(report).toMatchObject({ sensorId: "failing", status: "red" });
    expect(report.summary).toContain("code 7");
    expect(JSON.stringify(report)).not.toContain("secret diagnostic");
  });

  it("turns external timeout and oversized output into bounded red observations", async () => {
    const configPath = temporary("bounded-sensors.json");
    writeFileSync(configPath, JSON.stringify({
      external: [
        {
          id: "slow",
          label: "Slow",
          command: process.execPath,
          args: ["-e", "setTimeout(() => {}, 10000)"],
          timeoutMs: 100,
        },
        {
          id: "noisy",
          label: "Noisy",
          command: process.execPath,
          args: ["-e", "process.stdout.write('x'.repeat(70000))"],
        },
      ],
    }));
    const registry = new SensorRegistry({ env: { AGENT_BRIDGE_SENSOR_CONFIG: configPath } });
    await expect(registry.run("slow")).resolves.toMatchObject({ sensorId: "slow", status: "red" });
    const noisy = await registry.run("noisy");
    expect(noisy).toMatchObject({ sensorId: "noisy", status: "red" });
    expect(JSON.stringify(noisy).length).toBeLessThan(2000);
  }, 5000);

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

  it("normalizes every report to a bounded credential-redacted contract", () => {
    const report = normalizeSensorReport({
      sensorId: "example",
      label: "Example health",
      status: "red",
      checks: Array.from({ length: 40 }, (_, index) => ({
        name: `check-${index}`,
        status: "red" as const,
        message: index === 0
          ? '"token":"super-secret-value" Authorization: Bearer abcdefghijklmnopqrstuvwxyz https://user:pass@example.invalid eyJabcdefghijklmno.abcdefghijklmnop.abcdefghijklmnop'
          : "x".repeat(800),
        value: index === 0 ? "password=hunter2" : "y".repeat(500),
      })),
      summary: "api_key=abcdef1234567890 " + "z".repeat(800),
      timestamp: "2026-09-18T10:00:00Z",
    });

    expect(report.checks).toHaveLength(32);
    expect(report.checks.every((check) => check.name.length <= 120 && check.message.length <= 500)).toBe(true);
    expect(report.checks.every((check) => typeof check.value !== "string" || check.value.length <= 200)).toBe(true);
    expect(report.summary.length).toBeLessThanOrEqual(500);
    expect(JSON.stringify(report)).not.toContain("super-secret-value");
    expect(JSON.stringify(report)).not.toContain("hunter2");
    expect(JSON.stringify(report)).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(JSON.stringify(report)).not.toContain("user:pass");
    expect(JSON.stringify(report)).not.toContain("eyJabcdefghijklmno");
  });

  it("captures apt-check counts even when apt-check writes to stderr", () => {
    const script = temporary("apt-check");
    writeFileSync(script, "#!/bin/sh\nprintf '12;3' >&2\n");
    chmodSync(script, 0o755);
    expect(readAptUpdateStatus(script)).toEqual({ total: 12, security: 3 });
  });

  it("acknowledges a Sensor callback before slow execution and returns to the same topic exactly once", async () => {
    const events: string[] = [];
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const sent: Array<{ text: string; threadId?: number }> = [];
    const handled = await handleSensorCallback({
      data: "sensor:server",
      chatId: -100123,
      threadId: 42,
      runner: {
        list: () => [{ id: "server", label: "Server health" }],
        run: async () => {
          runs += 1;
          events.push("run");
          await gate;
          return {
            sensorId: "server", label: "Server health", status: "green",
            checks: [], summary: "ok", timestamp: new Date().toISOString(),
          };
        },
        runAll: async () => [],
      },
      acknowledge: async () => { events.push("ack"); },
      send: async (text, threadId) => { sent.push({ text, threadId }); },
    });
    expect(handled).toBe(true);
    expect(events).toEqual(["ack"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(["ack", "run"]);
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runs).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].threadId).toBe(42);
  });

  it("rejects forged Sensor callbacks without running a Sensor", async () => {
    let runs = 0;
    const acknowledgements: string[] = [];
    expect(await handleSensorCallback({
      data: "sensor:not-configured",
      chatId: 1,
      runner: {
        list: () => [{ id: "server", label: "Server health" }],
        run: async () => { runs += 1; throw new Error("must not run"); },
        runAll: async () => { runs += 1; return []; },
      },
      acknowledge: async (text) => { acknowledgements.push(text); },
      send: async () => {},
    })).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runs).toBe(0);
    expect(acknowledgements).toEqual(["Unknown sensor"]);
  });

  it("lists and runs all Sensors through the same packaged helper implementation", () => {
    const configPath = temporary("helper-list-sensors.json");
    const rawReport = JSON.stringify({
      status: "green", checks: [{ name: "external", status: "green", message: "ok" }],
      summary: "ok", timestamp: "2026-09-18T10:00:00Z",
    });
    writeFileSync(configPath, JSON.stringify({
      external: [{ id: "example", label: "Example", command: process.execPath, args: ["-e", `process.stdout.write(${JSON.stringify(rawReport)})`] }],
    }));
    const helper = fileURLToPath(new URL("../scripts/agent-bridge-sensors.ts", import.meta.url));
    const env = { ...process.env, AGENT_BRIDGE_SENSOR_CONFIG: configPath, AGENT_BRIDGE_CONTEXT_DB: "" };
    const listed = execFileSync(process.execPath, ["--import", "tsx", helper, "list"], { encoding: "utf8", env });
    expect(listed).toContain("agent-bridge\tAgent Bridge health");
    expect(listed).toContain("server\tServer health");
    expect(listed).toContain("example\tExample");
    const all = JSON.parse(execFileSync(process.execPath, ["--import", "tsx", helper, "run", "--all", "--json"], {
      encoding: "utf8", env,
    }));
    expect(all.map((report: { sensorId: string }) => report.sensorId)).toEqual(["agent-bridge", "server", "example"]);
  }, 10_000);

  it("reads the current interactive DB through AGENT_BRIDGE_CONTEXT_DB", () => {
    const dbPath = temporary("helper-context.sqlite");
    const db = openDb(dbPath, { serviceId: "sensor-test", runId: "sensor-test" });
    db.close();
    const helper = fileURLToPath(new URL("../scripts/agent-bridge-sensors.ts", import.meta.url));
    const report = JSON.parse(execFileSync(process.execPath, ["--import", "tsx", helper, "run", "agent-bridge", "--json"], {
      encoding: "utf8",
      env: { ...process.env, AGENT_BRIDGE_CONTEXT_DB: dbPath, AGENT_BRIDGE_SENSOR_CONFIG: "" },
    }));
    expect(report.checks.find((check: { name: string }) => check.name === "db-file")?.status).toBe("green");
    expect(report.checks.find((check: { name: string }) => check.name === "db-read")?.status).toBe("green");
  });

  it("delegates scheduled Sensor execution to the existing routines capability", () => {
    const skill = readFileSync(fileURLToPath(new URL("../skills/sensors/SKILL.md", import.meta.url)), "utf8");
    expect(skill).toContain("scheduled-routines");
    expect(skill).toContain('agent-bridge-sensors');
    expect(skill).toContain("Do not create a second schedule");
  });

  it("uses the same bounded redacted contract through the packaged helper path", () => {
    const configPath = temporary("helper-sensors.json");
    const rawReport = JSON.stringify({
      status: "red",
      checks: [{ name: "auth", status: "red", message: "token=helper-secret" }],
      summary: "password=helper-password",
      timestamp: "2026-09-18T10:00:00Z",
    });
    writeFileSync(configPath, JSON.stringify({
      external: [{
        id: "example",
        label: "Example",
        command: process.execPath,
        args: ["-e", `process.stdout.write(${JSON.stringify(rawReport)})`],
      }],
    }));
    const helper = fileURLToPath(new URL("../scripts/agent-bridge-sensors.ts", import.meta.url));
    const output = execFileSync(process.execPath, ["--import", "tsx", helper, "run", "example", "--json"], {
      encoding: "utf8",
      env: { ...process.env, AGENT_BRIDGE_SENSOR_CONFIG: configPath, AGENT_BRIDGE_CONTEXT_DB: "" },
    });
    const report = JSON.parse(output);
    expect(report.sensorId).toBe("example");
    expect(output).not.toContain("helper-secret");
    expect(output).not.toContain("helper-password");
  });

  it("bounds combined Telegram Sensor output", () => {
    const report = {
      sensorId: "example",
      label: "Example health",
      status: "red" as const,
      checks: Array.from({ length: 32 }, (_, index) => ({
        name: `check-${index}`,
        status: "red" as const,
        message: "x".repeat(500),
      })),
      summary: "red",
      timestamp: "2026-09-18T10:00:00Z",
    };
    expect(formatSensorReports([report, report])).toHaveLength(3900);
  });
});
