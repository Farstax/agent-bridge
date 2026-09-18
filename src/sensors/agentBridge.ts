import { existsSync } from "node:fs";
import type { Sensor, SensorReport, SensorCheck } from "./types.js";
import type { BridgeDb } from "../db.js";
import { readInstalledProviderVersions } from "../providers/qualificationStatus.js";
import { resolveProviderRuntime } from "../providers/acpRuntime.js";
import type { ProviderId } from "../providers/types.js";

function inspectReleaseLockedAcpProvider(
  providerId: ProviderId,
  runtimeVersions: Partial<Record<ProviderId, string>>,
): SensorCheck | null {
  const selected = resolveProviderRuntime(providerId);
  if (selected.transport !== "acp-stdio" || !selected.selectedVersion) return null;
  const observedVersion = runtimeVersions[providerId];
  const name = `cli-update-${providerId}`;
  if (!observedVersion) {
    return { name, status: "red", message: `${providerId} ACP adapter executable not found` };
  }
  if (observedVersion !== selected.selectedVersion) {
    return {
      name,
      status: "amber",
      message: `${providerId} ACP adapter runtime ${observedVersion} differs from release lock ${selected.selectedVersion}`,
    };
  }
  const label = providerId === "codex" ? "bundled Codex ACP adapter" : `${providerId} ACP adapter`;
  return { name, status: "green", message: `${label} ${observedVersion}` };
}

export class AgentBridgeSensor implements Sensor {
  readonly id = "agent-bridge";
  readonly label = "Agent Bridge health";
  private db?: BridgeDb;
  private dbPath?: string;
  constructor(db?: BridgeDb, dbPath?: string) {
    this.db = db;
    this.dbPath = dbPath;
  }

  async check(): Promise<SensorReport> {
    const checks: SensorCheck[] = [];

    const dbExists = !!this.dbPath && existsSync(this.dbPath);
    checks.push({
      name: "db-file",
      status: dbExists ? "green" : "red",
      message: dbExists ? "Interactive DB file accessible" : "Interactive DB path unavailable",
    });

    if (dbExists) {
      try {
        this.db?.raw.prepare("SELECT 1").get();
        checks.push({ name: "db-read", status: "green", message: "DB read OK" });
      } catch (e) {
        checks.push({ name: "db-read", status: "red", message: `DB error: ${(e as Error).message}` });
      }
    }

    // Circuit breaker state
    let cbStatus: "green" | "amber" | "red" = "green";
    let cbMessage = "No consecutive failures";
    try {
      const failures = this.db?.getMaxConsecutiveFailures() ?? [];
      if (failures.length > 0) {
        const tripped = failures.filter(f => f.count >= 2);
        const warned = failures.filter(f => f.count === 1);
        if (tripped.length > 0) {
          cbStatus = "red";
          cbMessage = `Circuit breaker tripped: ${tripped.map(f => `${f.bot}(${f.count})`).join(", ")}`;
        } else if (warned.length > 0) {
          cbStatus = "amber";
          cbMessage = `1 failure recorded: ${warned.map(f => f.bot).join(", ")}`;
        }
      }
    } catch {
      cbStatus = "amber";
      cbMessage = "Could not read circuit breaker state";
    }
    checks.push({ name: "circuit-breaker", status: cbStatus, message: cbMessage });

    // Release-locked ACP adapters are checked against the installed release
    // manifest. They never use mutable global npm package state.
    const runtimeVersions = readInstalledProviderVersions();
    for (const providerId of ["codex", "claude", "agy", "grok", "cursor"] as const) {
      const acpCheck = inspectReleaseLockedAcpProvider(providerId, runtimeVersions);
      if (acpCheck) checks.push(acpCheck);
    }

    const worst = checks.some(c => c.status === "red") ? "red"
                : checks.some(c => c.status === "amber") ? "amber"
                : "green";

    const failingChecks = checks.filter(c => c.status !== "green").map(c => c.name);
    const summary = worst === "green"
      ? "All systems nominal"
      : `Issues: ${failingChecks.join(", ")}`;

    return {
      sensorId: this.id,
      label: this.label,
      status: worst,
      checks,
      summary,
      timestamp: new Date().toISOString(),
    };
  }
}

