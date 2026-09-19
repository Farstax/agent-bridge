import os from "node:os";
import { existsSync, readFileSync, readdirSync, statSync, statfsSync } from "node:fs";
import { join } from "node:path";
import { execSync, spawnSync } from "node:child_process";
import type { Sensor, SensorReport, SensorCheck } from "./types.js";
import { normalizeSensorReport } from "./report.js";

export function readAptUpdateStatus(aptCheckPath = "/usr/lib/update-notifier/apt-check"): { total: number; security: number } | null {
  if (!existsSync(aptCheckPath)) return null;
  const result = spawnSync(aptCheckPath, [], { encoding: "utf8", timeout: 5000 });
  if (result.error) throw result.error;
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  const match = output.match(/(\d+);(\d+)/);
  if (!match) throw new Error("apt-check returned an invalid result");
  return { total: Number(match[1]), security: Number(match[2]) };
}

export class ServerSensor implements Sensor {
  readonly id = "server";
  readonly label = "Server health";


  async check(): Promise<SensorReport> {
    const checks: SensorCheck[] = [];

    // ── Performance Checks ───────────────────────────────────────────────────

    // 1. CPU Load Average (1-minute)
    const cpus = os.cpus().length || 1;
    const loadAvg = os.loadavg();
    const load1m = loadAvg[0] ?? 0;
    
    const amberThreshold = cpus * 1.0;
    const redThreshold = cpus * 1.5;

    let loadStatus: "green" | "amber" | "red" = "green";
    if (load1m >= redThreshold) {
      loadStatus = "red";
    } else if (load1m >= amberThreshold) {
      loadStatus = "amber";
    }

    let topProcessesMsg = "";
    if (loadStatus !== "green" && os.platform() === "linux") {
      try {
        const topOutput = execSync("ps -eo pid,pcpu,comm --sort=-pcpu | head -n 4", { stdio: ["ignore", "pipe", "ignore"], timeout: 1000 }).toString().trim();
        topProcessesMsg = `\nTop CPU processes:\n${topOutput}`;
      } catch {
        // ignore
      }
    }

    const load5m = loadAvg[1] ?? 0;
    const load15m = loadAvg[2] ?? 0;
    checks.push({
      name: "cpu-load",
      status: loadStatus,
      message: `1m: ${load1m.toFixed(2)}  5m: ${load5m.toFixed(2)}  15m: ${load15m.toFixed(2)} (${cpus} CPUs)${topProcessesMsg}`,
      value: Number(load1m.toFixed(2)),
    });

    // 2. Memory (RAM) Usage
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const memPct = (usedMem / totalMem) * 100;
    
    const memAmberPct = 80;
    const memRedPct = 95;
    let memStatus: "green" | "amber" | "red" = "green";
    if (memPct >= memRedPct) {
      memStatus = "red";
    } else if (memPct >= memAmberPct) {
      memStatus = "amber";
    }

    const usedGB = (usedMem / 1024 / 1024 / 1024).toFixed(1);
    const totalGB = (totalMem / 1024 / 1024 / 1024).toFixed(1);
    
    checks.push({
      name: "memory-usage",
      status: memStatus,
      message: `Memory usage: ${memPct.toFixed(1)}% (${usedGB} GB of ${totalGB} GB used)`,
      value: Number(memPct.toFixed(1)),
    });

    // 3. Swap Usage
    let swapStatus: "green" | "amber" | "red" = "green";
    let swapMsg = "Swap disabled";
    let swapPct: number | undefined = undefined;
    const swapAmberPct = 80;
    const swapRedPct = 95;
    try {
      if (existsSync("/proc/meminfo")) {
          const content = readFileSync("/proc/meminfo", "utf8");
          const totalMatch = content.match(/^SwapTotal:\s+(\d+)\s+kB/m);
          const freeMatch = content.match(/^SwapFree:\s+(\d+)\s+kB/m);
          if (totalMatch && freeMatch) {
            const total = Number(totalMatch[1]);
            const free = Number(freeMatch[1]);
            if (total > 0) {
              const used = total - free;
              swapPct = (used / total) * 100;
              const usedMB = (used / 1024).toFixed(0);
              const totalMB = (total / 1024).toFixed(0);
              swapMsg = `Swap usage: ${swapPct.toFixed(1)}% (${usedMB} MB of ${totalMB} MB used)`;
              if (swapPct >= swapRedPct) {
                swapStatus = "red";
              } else if (swapPct >= swapAmberPct) {
                // To avoid false positives, only flag swap usage as amber if RAM usage is also under pressure
                if (memStatus !== "green") {
                  swapStatus = "amber";
                }
              }
            }
          }
      }
    } catch (err) {
      swapStatus = "amber";
      swapMsg = `Failed to check swap: ${(err as Error).message}`;
    }
    checks.push({
      name: "swap-usage",
      status: swapStatus,
      message: swapMsg,
      value: swapPct !== undefined ? Number(swapPct.toFixed(1)) : undefined,
    });

    // 4. Zombie Processes
    let zombieStatus: "green" | "amber" | "red" = "green";
    let zombieMsg = "No zombie processes detected";
    let zombieCount = 0;
    try {
      const output = execSync("ps -eo state", { stdio: ["ignore", "pipe", "ignore"] }).toString();
      zombieCount = (output.match(/Z/g) || []).length;
      if (zombieCount > 0) {
        zombieMsg = `${zombieCount} zombie process(es) detected`;
        if (zombieCount >= 5) {
          zombieStatus = "red";
        } else {
          zombieStatus = "amber";
        }
      }
    } catch {
      // Fallback if ps command fails
    }
    checks.push({
      name: "zombies",
      status: zombieStatus,
      message: zombieMsg,
      value: zombieCount,
    });

    // 5. System Uptime
    const uptimeSec = os.uptime();
    const uptimeDays = Math.floor(uptimeSec / 86400);
    const uptimeHours = Math.floor((uptimeSec % 86400) / 3600);
    const uptimeMsg = uptimeDays > 0 
      ? `${uptimeDays}d ${uptimeHours}h`
      : `${uptimeHours}h`;

    checks.push({
      name: "uptime",
      status: "green",
      message: `System uptime: ${uptimeMsg}`,
      value: uptimeSec,
    });

    // ── Security Checks ──────────────────────────────────────────────────────

    // 6. Firewall (UFW) Status
    let ufwStatus: "green" | "amber" = "green";
    let ufwMsg = "UFW firewall is active";
    try {
      const output = execSync("systemctl is-active ufw", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
      if (output !== "active") {
        ufwStatus = "amber";
        ufwMsg = `UFW firewall is inactive (status: ${output})`;
      }
    } catch {
      ufwStatus = "amber";
      ufwMsg = "UFW firewall service check failed or inactive";
    }
    checks.push({
      name: "firewall",
      status: ufwStatus,
      message: ufwMsg,
    });

    // 7. SSH Private Key Permissions
    const sshDir = join(os.homedir(), ".ssh");
    let sshStatus: "green" | "amber" | "red" = "green";
    let sshMsg = "SSH key file permissions secure";
    if (existsSync(sshDir)) {
      try {
        const files = readdirSync(sshDir);
        const unsafeFiles: string[] = [];
        for (const file of files) {
          if ((file.startsWith("id_") || file === "identity") && !file.endsWith(".pub")) {
            const filePath = join(sshDir, file);
            const stat = statSync(filePath);
            const mode = stat.mode & 0o777;
            // Mode should not have any group (0o070) or world (0o007) permissions (0o077 mask)
            if ((mode & 0o077) !== 0) {
              unsafeFiles.push(`${file} (0${mode.toString(8)})`);
            }
          }
        }
        if (unsafeFiles.length > 0) {
          sshStatus = "red";
          sshMsg = `Unsafe SSH private key permissions: ${unsafeFiles.join(", ")}`;
        }
      } catch (err) {
        sshStatus = "amber";
        sshMsg = `Failed to check SSH key permissions: ${(err as Error).message}`;
      }
    }
    checks.push({
      name: "ssh-key-perms",
      status: sshStatus,
      message: sshMsg,
    });

    // 8. Local Environment File Permissions
    const projectDir = process.cwd();
    let envStatus: "green" | "amber" = "green";
    let envMsg = "Environment file permissions secure";
    try {
      const files = readdirSync(projectDir);
      const unsafeEnvFiles: string[] = [];
      for (const file of files) {
        if (file.startsWith(".env") && !file.endsWith(".example") && file !== ".env.defaults") {
          const filePath = join(projectDir, file);
          const stat = statSync(filePath);
          const mode = stat.mode & 0o777;
          // Mode should not have any group or world access (0o077 mask)
          if ((mode & 0o077) !== 0) {
            unsafeEnvFiles.push(`${file} (0${mode.toString(8)})`);
          }
        }
      }
      if (unsafeEnvFiles.length > 0) {
        envStatus = "amber";
        envMsg = `Loose permissions on environment files: ${unsafeEnvFiles.join(", ")}`;
      }
    } catch {
      // Skip if cannot check project directory
    }
    checks.push({
      name: "env-file-perms",
      status: envStatus,
      message: envMsg,
    });

    // 9. Disk Space (root filesystem)
    let diskStatus: "green" | "amber" | "red" = "green";
    let diskMsg = "Disk space OK";
    let diskFreeGB: number | undefined;
    try {
      const stats = statfsSync("/");
      const freeBytes = stats.bfree * stats.bsize;
      diskFreeGB = Math.round((freeBytes / (1024 ** 3)) * 10) / 10;
      if (diskFreeGB < 0.5) {
        diskStatus = "red";
        diskMsg = `Only ${diskFreeGB} GB free on /`;
      } else if (diskFreeGB < 2) {
        diskStatus = "amber";
        diskMsg = `${diskFreeGB} GB free on / (low)`;
      } else {
        diskMsg = `${diskFreeGB} GB free on /`;
      }
    } catch (err) {
      diskStatus = "amber";
      diskMsg = `Disk check failed: ${(err as Error).message}`;
    }
    checks.push({ name: "disk-space", status: diskStatus, message: diskMsg, value: diskFreeGB });

    // 10. Disk Space — /tmp
    for (const [mountLabel, mountPath] of [["disk-space-tmp", "/tmp"], ["disk-space-home", os.homedir()]] as [string, string][]) {
      let mStatus: "green" | "amber" | "red" = "green";
      let mMsg = `${mountPath} OK`;
      let mFreeGB: number | undefined;
      try {
        const mStats = statfsSync(mountPath);
        const mFreeBytes = mStats.bfree * mStats.bsize;
        mFreeGB = Math.round((mFreeBytes / (1024 ** 3)) * 10) / 10;
        if (mFreeGB < 0.5) {
          mStatus = "red";
          mMsg = `Only ${mFreeGB} GB free on ${mountPath}`;
        } else if (mFreeGB < 2) {
          mStatus = "amber";
          mMsg = `${mFreeGB} GB free on ${mountPath} (low)`;
        } else {
          mMsg = `${mFreeGB} GB free on ${mountPath}`;
        }
      } catch (err) {
        mStatus = "amber";
        mMsg = `${mountPath} disk check failed: ${(err as Error).message}`;
      }
      checks.push({ name: mountLabel, status: mStatus, message: mMsg, value: mFreeGB });
    }

    // 11. Inode Exhaustion (root filesystem)
    let inodeStatus: "green" | "amber" | "red" = "green";
    let inodeMsg = "Inodes OK";
    try {
      const iStats = statfsSync("/");
      const inodeTotal = iStats.files;
      const inodeFree = iStats.ffree;
      if (inodeTotal > 0) {
        const inodeUsedPct = Math.round(((inodeTotal - inodeFree) / inodeTotal) * 100);
        if (inodeUsedPct >= 95) {
          inodeStatus = "red";
          inodeMsg = `Inode usage critical: ${inodeUsedPct}% used on /`;
        } else if (inodeUsedPct >= 80) {
          inodeStatus = "amber";
          inodeMsg = `Inode usage: ${inodeUsedPct}% used on /`;
        } else {
          inodeMsg = `Inode usage: ${inodeUsedPct}% used on /`;
        }
      }
    } catch (err) {
      inodeStatus = "amber";
      inodeMsg = `Inode check failed: ${(err as Error).message}`;
    }
    checks.push({ name: "inode-usage", status: inodeStatus, message: inodeMsg });

    // 13. Failed Systemd Services
    let svcStatus: "green" | "amber" | "red" = "green";
    let svcMsg = "No failed services";
    try {
      const output = execSync(
        "systemctl list-units --state=failed --no-legend --plain 2>/dev/null || true",
        { stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }
      ).toString().trim();
      const failedUnits = output ? output.split("\n").map(l => l.trim().split(/\s+/)[0]).filter(Boolean) : [];
      if (failedUnits.length > 0) {
        svcStatus = failedUnits.length >= 3 ? "red" : "amber";
        svcMsg = `${failedUnits.length} failed unit(s): ${failedUnits.slice(0, 3).join(", ")}`;
      }
    } catch {
      svcStatus = "amber";
      svcMsg = "Could not query systemd service state";
    }
    checks.push({ name: "failed-services", status: svcStatus, message: svcMsg });

    // 14. Pending updates
    let updatesStatus: "green" | "amber" | "red" = "green";
    let updatesMsg = "All packages up to date";
    if (os.platform() === "linux") {
      try {
        const updates = readAptUpdateStatus();
        if (updates) {
          if (updates.security > 0) {
            updatesStatus = "amber";
            updatesMsg = `${updates.total} update(s) available (${updates.security} security update(s))`;
          } else if (updates.total > 0) {
            updatesMsg = `${updates.total} update(s) available (0 security updates)`;
          }
        }
      } catch {
        updatesStatus = "amber";
        updatesMsg = "Could not query package update state";
      }
    }
    checks.push({ name: "pending-updates", status: updatesStatus, message: updatesMsg });

    // 15. Reboot required
    let rebootStatus: "green" | "amber" = "green";
    let rebootMsg = "No reboot required";
    if (existsSync("/var/run/reboot-required")) {
      rebootStatus = "amber";
      try {
        let pkgList = "";
        if (existsSync("/var/run/reboot-required.pkgs")) {
          const pkgs = readFileSync("/var/run/reboot-required.pkgs", "utf8")
            .trim()
            .split("\n")
            .map(p => p.trim())
            .filter(Boolean);
          if (pkgs.length > 0) {
            pkgList = ` (packages: ${pkgs.join(", ")})`;
          }
        }
        rebootMsg = `Reboot required by system updates${pkgList}`;
      } catch {
        rebootMsg = "Reboot required by system updates";
      }
    }
    checks.push({ name: "reboot-required", status: rebootStatus, message: rebootMsg });

    // ── Overall Status ───────────────────────────────────────────────────────

    const worst = checks.some(c => c.status === "red") ? "red"
                : checks.some(c => c.status === "amber") ? "amber"
                : "green";

    return normalizeSensorReport({
      sensorId: this.id,
      label: this.label,
      status: worst,
      checks,
      summary: worst === "green" ? "Server stats and security policies nominal" : "Server resource or security policy warning",
      timestamp: new Date().toISOString(),
    });
  }
}
