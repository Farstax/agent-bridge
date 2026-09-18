import { readFileSync } from "node:fs";
import type { BridgeDb } from "../db.js";
import { AgentBridgeSensor } from "./agentBridge.js";
import { ServerSensor } from "./server.js";
import { ExternalSensor } from "./external.js";
import type { Sensor, SensorReport } from "./types.js";

const ID = /^[a-z0-9][a-z0-9._-]{0,56}$/;
const MAX_EXTERNAL = 32;
const RESERVED_IDS = new Set(["all", "agent-bridge", "server"]);

interface ExternalDefinition {
  id: string;
  label: string;
  command: string;
  args?: string[];
  timeoutMs?: number;
}

function readExternalDefinitions(path: string | undefined): ExternalDefinition[] {
  if (!path?.trim()) return [];
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { external?: unknown };
  if (!Array.isArray(parsed.external)) throw new Error("sensor config external must be an array");
  if (parsed.external.length > MAX_EXTERNAL) throw new Error("sensor config has too many external sensors");
  const seen = new Set<string>();
  return parsed.external.map((value, index) => {
    if (!value || typeof value !== "object") throw new Error(`sensor config entry ${index} must be an object`);
    const item = value as Record<string, unknown>;
    if (typeof item.id !== "string" || !ID.test(item.id) || RESERVED_IDS.has(item.id)) throw new Error(`invalid or reserved sensor id at entry ${index}`);
    if (seen.has(item.id)) throw new Error(`duplicate sensor id: ${item.id}`);
    seen.add(item.id);
    if (typeof item.label !== "string" || !item.label.trim() || item.label.length > 100) throw new Error(`invalid sensor label: ${item.id}`);
    if (typeof item.command !== "string" || !item.command.startsWith("/") || item.command.length > 500) throw new Error(`invalid sensor command: ${item.id}`);
    if (item.args !== undefined && (!Array.isArray(item.args) || item.args.some((arg) => typeof arg !== "string" || arg.length > 1000))) {
      throw new Error(`invalid sensor args: ${item.id}`);
    }
    const timeoutMs = item.timeoutMs === undefined ? 30_000 : Number(item.timeoutMs);
    if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) throw new Error(`invalid sensor timeout: ${item.id}`);
    return { id: item.id, label: item.label.trim(), command: item.command, args: (item.args as string[] | undefined) ?? [], timeoutMs };
  });
}

export class SensorRegistry {
  private readonly sensors: Sensor[];

  constructor(options: { db?: BridgeDb; dbPath?: string; env?: Record<string, string | undefined> } = {}) {
    const env = options.env ?? process.env;
    this.sensors = [
      new AgentBridgeSensor(options.db, options.dbPath),
      new ServerSensor(env),
      ...readExternalDefinitions(env.AGENT_BRIDGE_SENSOR_CONFIG).map((item) =>
        new ExternalSensor(item.id, item.label, item.command, item.args, item.timeoutMs)),
    ];
  }

  list(): Array<{ id: string; label: string }> {
    return this.sensors.map(({ id, label }) => ({ id, label }));
  }

  async run(id: string): Promise<SensorReport> {
    const sensor = this.sensors.find((candidate) => candidate.id === id);
    if (!sensor) throw new Error(`unknown sensor: ${id}`);
    return await sensor.check();
  }

  async runAll(): Promise<SensorReport[]> {
    return await Promise.all(this.sensors.map((sensor) => sensor.check()));
  }
}
