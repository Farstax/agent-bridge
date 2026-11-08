import { describe, expect, it, vi } from "vitest";
import { AcpCommands, type AcpCommandOptions } from "../src/acpServer/commands.js";
import type { SensorReport } from "../src/sensors/types.js";

const report: SensorReport = {
  sensorId: "external-check",
  label: "External health",
  status: "amber",
  summary: "One warning",
  timestamp: "2026-11-08T10:00:00.000Z",
  checks: [{ name: "latency", status: "amber", message: "Elevated latency", value: 220 }],
};

function fixture() {
  const run = vi.fn(async (_id: string) => report);
  const runAll = vi.fn(async () => [report]);
  const sensors = {
    list: () => [{ id: "agent-bridge", label: "Agent Bridge health" }, { id: "external-check", label: "External health" }],
    run, runAll,
  };
  const commands = new AcpCommands({
    control: { status: () => ({ selectedProvider: "codex", providers: [] }) },
    sensors,
  } as unknown as AcpCommandOptions);
  const session = { sessionId: "session", conversationId: "conv", cwd: "/apps" } as Parameters<AcpCommands["run"]>[0];
  return { commands, session, run, runAll };
}

describe("outward ACP sensors", () => {
  it("lists built-in and configured sensors without requiring provider authentication", async () => {
    const { commands, session, run } = fixture();
    const entry = commands.catalogue(session).find((command) => command.name === "sensors");
    expect(entry?.available).toBe(true);
    const result = await commands.run(session, { command: "/sensors" });
    expect(result.options?.map((item) => item.token)).toEqual(["sensor:agent-bridge", "sensor:external-check", "sensor:all"]);
    expect(run).not.toHaveBeenCalled();
    expect(result.sensorReports).toBeUndefined();
  });

  it("returns real structured observations and Telegram-compatible human text", async () => {
    const { commands, session, run } = fixture();
    const result = await commands.run(session, { command: "/sensors", select: "sensor:external-check" });
    expect(run).toHaveBeenCalledExactlyOnceWith("external-check");
    expect(result.sensorReports).toEqual([report]);
    expect(result.text).toContain("Elevated latency");
  });

  it("runs all sensors without a provider Run", async () => {
    const { commands, session, runAll } = fixture();
    const result = await commands.run(session, { command: "/sensors", select: "sensor:all" });
    expect(runAll).toHaveBeenCalledOnce();
    expect(result.sensorReports).toHaveLength(1);
  });

  it.each(["sensor:unknown", "server", "sensor:", "sensor:../etc/passwd", "sensor:ALL"])("rejects unregistered selection %s", async (select) => {
    const { commands, session, run, runAll } = fixture();
    await expect(commands.run(session, { command: "/sensors", select })).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
    expect(runAll).not.toHaveBeenCalled();
  });

  it("does not expose Sensors when the runtime has no registry", () => {
    const { commands, session } = fixture();
    const without = new AcpCommands({ control: { status: () => ({ selectedProvider: "codex", providers: [] }) } } as unknown as AcpCommandOptions);
    expect(without.catalogue(session).find((command) => command.name === "sensors")?.available).toBe(false);
    expect(commands.catalogue(session).find((command) => command.name === "autonomy")?.available).toBe(false);
  });
});
