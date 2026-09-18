#!/usr/bin/env node
import Database from "better-sqlite3";
import { BridgeDb } from "../src/db.js";
import { SensorRegistry } from "../src/sensors/registry.js";
import { formatSensorReport, formatSensorReports } from "../src/sensors/telegram.js";

function openContextDb(): { db?: BridgeDb; close: () => void } {
  const path = process.env.AGENT_BRIDGE_CONTEXT_DB?.trim();
  if (!path) return { close: () => {} };
  const raw = new Database(path, { readonly: true, fileMustExist: true });
  return { db: new BridgeDb(raw, { serviceId: "sensor-helper", runId: `sensor-helper-${process.pid}` }), close: () => raw.close() };
}

async function main(args: string[]): Promise<string> {
  const command = args[0];
  const context = openContextDb();
  try {
    const registry = new SensorRegistry({ db: context.db, dbPath: process.env.AGENT_BRIDGE_CONTEXT_DB, env: process.env });
    if (command === "list") return registry.list().map((sensor) => `${sensor.id}\t${sensor.label}`).join("\n");
    if (command !== "run") throw new Error("usage: agent-bridge-sensors <list|run> [sensor-id|--all] [--json]");
    const target = args[1];
    const json = args.includes("--json");
    if (!target) throw new Error("run requires a sensor id or --all");
    if (target === "--all") {
      const reports = await registry.runAll();
      return json ? JSON.stringify(reports) : formatSensorReports(reports);
    }
    const report = await registry.run(target);
    return json ? JSON.stringify(report) : formatSensorReport(report);
  } finally {
    context.close();
  }
}

main(process.argv.slice(2))
  .then((output) => process.stdout.write(output + "\n"))
  .catch((error) => {
    process.stderr.write(`agent-bridge-sensors: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
