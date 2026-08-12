import { existsSync, readdirSync } from "node:fs";
import https from "node:https";
import { execSync } from "node:child_process";
import { getHeapStatistics } from "node:v8";
import type { HealthPlugin, HealthReport, CheckResult } from "../types.js";
import type { BridgeDb } from "../../db.js";
import { readInstalledProviderVersions } from "../../providers/qualificationStatus.js";

const upgradeCommand = process.env.BRIDGE_UPGRADE_COMMAND ?? `${process.env.BRIDGE_PROJECT_DIR ?? process.cwd()}/scripts/upgrade.sh`;

export class SelfPlugin implements HealthPlugin {
  readonly name = "agent-bridge";
  private db: BridgeDb;
  private dbPath: string;
  private serviceNames: string[];

  constructor(db: BridgeDb, dbPath: string, serviceNames: string[] = []) {
    this.db = db;
    this.dbPath = dbPath;
    this.serviceNames = serviceNames;
  }

  async check(): Promise<HealthReport> {
    const checks: CheckResult[] = [];

    const dbExists = existsSync(this.dbPath);
    checks.push({
      name: "db-file",
      status: dbExists ? "green" : "red",
      message: dbExists ? "DB file accessible" : "DB file not found",
    });

    if (dbExists) {
      try {
        this.db.raw.prepare("SELECT 1").get();
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
      const failures = this.db.getMaxConsecutiveFailures();
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

    // Agent CLI update checks — CLIs are external global installs, not local deps
    let globalListParsed: Record<string, { version?: string }> = {};
    let globalListSuccess = false;
    try {
      const stdout = execSync("npm list -g --depth=0 --json", {
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 10000,
      }).toString();
      globalListParsed = (JSON.parse(stdout).dependencies ?? {}) as Record<string, { version?: string }>;
      globalListSuccess = true;
    } catch (err: any) {
      if (err.stdout) {
        try {
          globalListParsed = (JSON.parse(err.stdout.toString()).dependencies ?? {}) as Record<string, { version?: string }>;
          globalListSuccess = true;
        } catch { /* ignore */ }
      }
    }

    if (globalListSuccess) {
      const runtimeVersions = readInstalledProviderVersions();
      const cliSpecs = [
        { pkg: "@anthropic-ai/claude-code", provider: "claude" as const, checkName: "cli-update-claude-code" },
        { pkg: "@openai/codex", provider: "codex" as const, checkName: "cli-update-codex" },
      ];
      for (const { pkg, provider, checkName } of cliSpecs) {
        const installed = globalListParsed[pkg];
        const runtime = runtimeVersions[provider];
        if (!runtime) {
          checks.push({
            name: checkName,
            status: "red",
            message: `${provider} runtime executable not found — run: ${upgradeCommand}`,
          });
          continue;
        }
        const packageVersion = installed?.version;
        const mismatch = packageVersion && packageVersion !== runtime
          ? ` package metadata ${packageVersion} differs from runtime ${runtime}`
          : "";
        const current = runtime;
        try {
          const latest = execSync(`npm view ${pkg} version`, {
            stdio: ["ignore", "pipe", "ignore"],
            timeout: 5000,
          }).toString().trim();
          if (current !== latest) {
            const behind = getVersionsBehind(pkg, current, latest);
            let status: "green" | "amber" | "red" = "green";
            if (behind >= 10) status = "red";
            else if (behind >= 3) status = "amber";
            checks.push({
              name: checkName,
              status: mismatch ? "amber" : status,
              message: `${pkg} runtime ${current}${mismatch}; update available: ${current} -> ${latest} (${behind} version${behind === 1 ? "" : "s"} behind). Run: ${upgradeCommand}`,
            });
          } else {
            checks.push({
              name: checkName,
              status: mismatch ? "amber" : "green",
              message: `${pkg} runtime ${current}${mismatch} is up to date. Run: ${upgradeCommand}`,
            });
          }
        } catch {
          checks.push({
            name: checkName,
            status: mismatch ? "amber" : "green",
            message: `${pkg} runtime ${current}${mismatch} (latest version unavailable)`,
          });
        }
      }
    }
    if (!globalListSuccess) {
      // Package metadata is optional diagnostic input; runtime state remains
      // authoritative even when npm cannot be queried.
      for (const { provider, checkName } of [
        { provider: "claude" as const, checkName: "cli-update-claude-code" },
        { provider: "codex" as const, checkName: "cli-update-codex" },
      ]) {
        const runtime = readInstalledProviderVersions()[provider];
        checks.push({
          name: checkName,
          status: runtime ? "amber" : "red",
          message: runtime
            ? `${provider} runtime ${runtime}; npm package metadata unavailable`
            : `${provider} runtime executable not found; npm package metadata unavailable`,
        });
      }
    }


    // ── Agy (Antigravity) version check ───────────────────────────────────────
    try {
      const agyVersion = execSync("agy --version", {
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
      }).toString().trim();
      checks.push({
        name: "agy-version",
        status: "green",
        message: `agy installed: ${agyVersion}. Run: ${upgradeCommand} to upgrade`,
      });
    } catch {
      checks.push({
        name: "agy-version",
        status: "red",
        message: `agy not found — run: ${upgradeCommand}`,
      });
    }

    // ── PR lifecycle gauges ────────────────────────────────────────────────────
    try {
      const openPrs = (this.db.raw.prepare(
        `SELECT COUNT(*) AS n FROM github_links
         WHERE pr_number IS NOT NULL AND pr_state NOT IN ('merged','closed')`
      ).get() as { n: number }).n;
      checks.push({
        name: "pr-open-count",
        status: "green",
        message: `${openPrs} open agent PR${openPrs !== 1 ? "s" : ""}`,
      });

      const stalePrs = (this.db.raw.prepare(
        `SELECT COUNT(*) AS n FROM github_links WHERE pr_state = 'stale'`
      ).get() as { n: number }).n;
      checks.push({
        name: "pr-stale-count",
        status: stalePrs > 0 ? "amber" : "green",
        message: `${stalePrs} stale PR${stalePrs !== 1 ? "s" : ""}`,
      });

      const pendingMerge = (this.db.raw.prepare(
        `SELECT COUNT(*) AS n FROM approvals
         WHERE approval_type = 'merge_pr' AND status = 'pending'`
      ).get() as { n: number }).n;
      checks.push({
        name: "pending-merge-approvals",
        status: "green",
        message: `${pendingMerge} pending merge approval${pendingMerge !== 1 ? "s" : ""}`,
      });
    } catch { /* non-fatal — DB may not have the columns yet */ }

    const worst = checks.some(c => c.status === "red") ? "red"
                : checks.some(c => c.status === "amber") ? "amber"
                : "green";

    const failingChecks = checks.filter(c => c.status !== "green").map(c => c.name);
    const summary = worst === "green"
      ? "All systems nominal"
      : `Issues: ${failingChecks.join(", ")}`;

    return {
      pluginName: this.name,
      status: worst,
      checks,
      summary,
      timestamp: new Date().toISOString(),
    };
  }
}


function getVersionsBehind(cliName: string, current: string, latest: string): number {
  if (current === latest) return 0;
  try {
    const stdout = execSync(`npm view ${cliName} versions --json`, {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).toString();
    const versions = JSON.parse(stdout);
    if (Array.isArray(versions)) {
      const currentIndex = versions.indexOf(current);
      const latestIndex = versions.indexOf(latest);
      if (currentIndex !== -1 && latestIndex !== -1) {
        return Math.max(0, latestIndex - currentIndex);
      }
    }
  } catch {
    // ignore/fallback
  }

  // Fallback estimation using semver components
  try {
    const pCurrent = current.split(".").map(Number);
    const pLatest = latest.split(".").map(Number);
    if (pCurrent.length === 3 && pLatest.length === 3 && pCurrent.every(n => !isNaN(n)) && pLatest.every(n => !isNaN(n))) {
      if (pLatest[0] > pCurrent[0]) {
        return 10; // Major version behind -> red (>= 10)
      }
      if (pLatest[1] > pCurrent[1]) {
        // Minor version behind -> at least amber (>= 3)
        const minorDiff = pLatest[1] - pCurrent[1];
        if (minorDiff === 1) {
          return 3 + Math.max(0, pLatest[2] - pCurrent[2]);
        }
        return Math.max(3, minorDiff * 3);
      }
      return Math.max(0, pLatest[2] - pCurrent[2]);
    }
  } catch {
    // fallback
  }

  return 1; // default fallback if we cannot determine
}
