import { existsSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { getHeapStatistics } from "node:v8";
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
  private serviceNames: string[];

  constructor(db?: BridgeDb, dbPath?: string, serviceNames: string[] = []) {
    this.db = db;
    this.dbPath = dbPath;
    this.serviceNames = serviceNames;
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

    // Process memory (RSS)
    const rssMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
    let memStatus: "green" | "amber" | "red" = "green";
    if (rssMB >= 1024) {
      memStatus = "red";
    } else if (rssMB >= 512) {
      memStatus = "amber";
    }
    checks.push({
      name: "process-memory",
      status: memStatus,
      message: `Bridge RSS: ${rssMB} MB`,
      value: rssMB,
    });

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

    // Node.js heap utilisation
    const memUsage = process.memoryUsage();
    const heapStats = getHeapStatistics();
    const heapPct = Math.max(1, Math.round((memUsage.heapUsed / heapStats.heap_size_limit) * 100));
    let heapStatus: "green" | "amber" | "red" = "green";
    if (heapPct >= 90) {
      heapStatus = "red";
    } else if (heapPct >= 75) {
      heapStatus = "amber";
    }
    checks.push({
      name: "heap-usage",
      status: heapStatus,
      message: `Heap: ${heapPct}% used (${Math.round(memUsage.heapUsed / 1024 / 1024)} MB / ${Math.round(heapStats.heap_size_limit / 1024 / 1024)} MB)`,
      value: heapPct,
    });

    // File descriptor count (Linux only)
    if (process.platform === "linux") {
      try {
        const fdEntries = readdirSync("/proc/self/fd");
        const fdCount = fdEntries.length;
        // Read the soft limit from /proc/self/limits
        let fdLimit = 1024;
        try {
          const limits = execSync("cat /proc/self/limits", { stdio: ["ignore", "pipe", "ignore"] }).toString();
          const match = limits.match(/Max open files\s+(\d+)/);
          if (match) fdLimit = Number(match[1]);
        } catch { /* use default */ }
        const fdPct = (fdCount / fdLimit) * 100;
        let fdStatus: "green" | "amber" | "red" = "green";
        if (fdPct >= 90) {
          fdStatus = "red";
        } else if (fdPct >= 75) {
          fdStatus = "amber";
        }
        checks.push({
          name: "fd-count",
          status: fdStatus,
          message: `FDs: ${fdCount} / ${fdLimit} (${Math.round(fdPct)}%)`,
          value: fdCount,
        });
      } catch {
        checks.push({ name: "fd-count", status: "amber", message: "Could not read FD count" });
      }
    }

    // Service restart count (systemd)
    if (this.serviceNames.length > 0) {
      let totalRestarts = 0;
      const restartDetails: string[] = [];
      for (const svc of this.serviceNames) {
        try {
          const out = execSync(`systemctl show ${svc} --property=NRestarts 2>/dev/null`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
          const match = out.match(/NRestarts=(\d+)/);
          if (match) {
            const count = Number(match[1]);
            totalRestarts += count;
            if (count > 0) restartDetails.push(`${svc}(${count})`);
          }
        } catch { /* service may not exist */ }
      }
      let restartStatus: "green" | "amber" | "red" = "green";
      if (totalRestarts >= 10) {
        restartStatus = "red";
      } else if (totalRestarts >= 3) {
        restartStatus = "amber";
      }
      const restartMsg = restartDetails.length > 0
        ? `${totalRestarts} restart(s): ${restartDetails.join(", ")}`
        : "No service restarts";
      checks.push({ name: "service-restarts", status: restartStatus, message: restartMsg, value: totalRestarts });
    }

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

