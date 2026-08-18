import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import https from "node:https";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: (path: string) => {
      if ((globalThis as any).__mockExistsSync) {
        const res = (globalThis as any).__mockExistsSync(path);
        if (res !== undefined) return res;
      }
      return actual.existsSync(path);
    },
    readFileSync: (path: string, options: any) => {
      if ((globalThis as any).__mockReadFileSync) {
        const res = (globalThis as any).__mockReadFileSync(path, options);
        if (res !== undefined) return res;
      }
      return actual.readFileSync(path, options);
    }
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: (command: string, args: string[], options: any) => {
      if (args.includes("--version")) {
        const mockedList = (globalThis as any).__mockExecSync?.("npm list -g --depth=0 --json");
        const installed = mockedList ? JSON.parse(String(mockedList)).dependencies ?? {} : {};
        if (command === "claude") return installed["@anthropic-ai/claude-code"]?.version ?? "2.1.185";
        if (command === "codex") return installed["@openai/codex"]?.version ?? "0.141.0";
        if (command === "agy") return "1.0.10";
      }
      return actual.execFileSync(command, args, options);
    },
    execSync: (cmd: string, options: any) => {
      if ((globalThis as any).__mockExecSync) {
        const res = (globalThis as any).__mockExecSync(cmd, options);
        if (res !== undefined) return res;
      }
      if (cmd.includes("npm list -g --depth=0 --json")) {
        return JSON.stringify({
          dependencies: {
            "@anthropic-ai/claude-code": { version: "2.1.185" },
            "@openai/codex": { version: "0.141.0" }
          }
        });
      }
      if (cmd.includes("npm view @anthropic-ai/claude-code version") && !cmd.includes("versions")) {
        return "2.1.185";
      }
      if (cmd.includes("npm view @openai/codex version") && !cmd.includes("versions")) {
        return "0.141.0";
      }
      if (cmd.includes("agy --version")) {
        return "1.0.10";
      }
      return actual.execSync(cmd, options);
    },
    execFileSync: (command: string, args: readonly string[], options: any) => {
      if ((globalThis as any).__mockExecFileSync) {
        const res = (globalThis as any).__mockExecFileSync(command, args, options);
        if (res !== undefined) return res;
      }
      if (args.includes("--version")) {
        if (command.includes("claude")) return "Claude Code 2.1.185";
        if (command.includes("codex")) return "codex 0.141.0";
        if (command.includes("agy")) return "agy 1.0.10";
      }
      return actual.execFileSync(command, args, options);
    },
  };
});

// ── formatReport ─────────────────────────────────────────────────────────────


describe("formatReport", () => {
  it("prefixes green status with checkmark emoji", async () => {
    const { formatReport } = await import("../src/health/reporter.js");
    const report = {
      pluginName: "test-plugin",
      status: "green" as const,
      checks: [],
      summary: "All good",
      timestamp: "2026-06-02T00:00:00.000Z",
    };
    expect(formatReport(report)).toContain("✅");
  });

  it("prefixes amber status with warning emoji", async () => {
    const { formatReport } = await import("../src/health/reporter.js");
    const report = {
      pluginName: "test-plugin",
      status: "amber" as const,
      checks: [],
      summary: "Some issues",
      timestamp: "2026-06-02T00:00:00.000Z",
    };
    expect(formatReport(report)).toContain("⚠️");
  });

  it("prefixes red status with red circle emoji", async () => {
    const { formatReport } = await import("../src/health/reporter.js");
    const report = {
      pluginName: "test-plugin",
      status: "red" as const,
      checks: [],
      summary: "Critical failure",
      timestamp: "2026-06-02T00:00:00.000Z",
    };
    expect(formatReport(report)).toContain("🔴");
  });

  it("includes plugin name and summary in output", async () => {
    const { formatReport } = await import("../src/health/reporter.js");
    const report = {
      pluginName: "content-crawler",
      status: "green" as const,
      checks: [],
      summary: "Queue healthy",
      timestamp: "2026-06-02T00:00:00.000Z",
    };
    const text = formatReport(report);
    expect(text).toContain("content-crawler");
    expect(text).toContain("Queue healthy");
  });

  it("renders each check with name and message", async () => {
    const { formatReport } = await import("../src/health/reporter.js");
    const report = {
      pluginName: "test-plugin",
      status: "amber" as const,
      checks: [
        { name: "queue-depth", status: "green" as const, message: "12 pending items" },
        { name: "failed-items", status: "amber" as const, message: "3 failed in last hour" },
      ],
      summary: "Minor issues",
      timestamp: "2026-06-02T00:00:00.000Z",
    };
    const text = formatReport(report);
    expect(text).toContain("queue-depth");
    expect(text).toContain("12 pending items");
    expect(text).toContain("failed-items");
    expect(text).toContain("3 failed in last hour");
  });

  it("wraps check details in a code block for readability", async () => {
    const { formatReport } = await import("../src/health/reporter.js");
    const report = {
      pluginName: "server",
      status: "amber" as const,
      checks: [
        { name: "cpu-load", status: "amber" as const, message: "load 2.4 (threshold 2.0)" },
      ],
      summary: "Load elevated",
      timestamp: "2026-06-02T00:00:00.000Z",
    };
    const text = formatReport(report);
    // Header and summary remain outside the code block
    expect(text).toContain("[server]");
    expect(text).toContain("Load elevated");
    // Check details are inside a fenced code block
    const codeBlockMatch = text.match(/```[\s\S]+?```/);
    expect(codeBlockMatch).not.toBeNull();
    expect(codeBlockMatch![0]).toContain("cpu-load");
    expect(codeBlockMatch![0]).toContain("load 2.4 (threshold 2.0)");
  });

  it("escapes underscores in summary to prevent markdown corruption", async () => {
    const { formatReport } = await import("../src/health/reporter.js");
    const report = {
      pluginName: "content-crawler",
      status: "green" as const,
      checks: [],
      summary: "Queue_depth_fast is high",
      timestamp: "2026-06-02T00:00:00.000Z",
    };
    const text = formatReport(report);
    expect(text).toContain("Queue\\_depth\\_fast is high");
  });
});

describe("formatAggregateReport", () => {
  it("shows stale and missing evidence when no current report is available", async () => {
    const { formatAggregateReport } = await import("../src/health/reporter.js");

    const text = formatAggregateReport({
      status: null,
      reports: [],
      nonGreenReports: [],
      evidence: { missingPluginNames: ["server"], stalePluginNames: ["agent-bridge"] },
    });

    expect(text).toContain("Missing plugin reports");
    expect(text).toContain("server");
    expect(text).toContain("Stale plugin reports");
    expect(text).toContain("agent-bridge");
  });
});

// ── ExternalPlugin ────────────────────────────────────────────────────────────

describe("ExternalPlugin", () => {
  it("parses JSON output from a successful command", async () => {
    const { ExternalPlugin } = await import("../src/health/plugins/external.js");
    const report = {
      pluginName: "content-crawler",
      status: "green",
      checks: [{ name: "queue", status: "green", message: "ok" }],
      summary: "healthy",
      timestamp: "2026-06-02T00:00:00.000Z",
    };
    const plugin = new ExternalPlugin({
      name: "content-crawler",
      command: "node",
      args: ["-e", `process.stdout.write(${JSON.stringify(JSON.stringify(report))})`],
    });
    const result = await plugin.check();
    expect(result.status).toBe("green");
    expect(result.pluginName).toBe("content-crawler");
  });

  it("returns red report when command exits non-zero", async () => {
    const { ExternalPlugin } = await import("../src/health/plugins/external.js");
    const plugin = new ExternalPlugin({
      name: "failing-plugin",
      command: "node",
      args: ["-e", "process.exit(1)"],
    });
    const result = await plugin.check();
    expect(result.status).toBe("red");
    expect(result.pluginName).toBe("failing-plugin");
  });

  it("returns red report when command outputs invalid JSON", async () => {
    const { ExternalPlugin } = await import("../src/health/plugins/external.js");
    const plugin = new ExternalPlugin({
      name: "broken-plugin",
      command: "node",
      args: ["-e", "console.log('not json')"],
    });
    const result = await plugin.check();
    expect(result.status).toBe("red");
    expect(result.checks[0].message).toContain("not json");
  });

  it("returns red report when command is not found", async () => {
    const { ExternalPlugin } = await import("../src/health/plugins/external.js");
    const plugin = new ExternalPlugin({
      name: "missing-plugin",
      command: "command-that-does-not-exist-xyz",
      args: [],
    });
    const result = await plugin.check();
    expect(result.status).toBe("red");
  });
});

// ── SelfPlugin ────────────────────────────────────────────────────────────────

describe("SelfPlugin", () => {
  it("reports green when DB file exists and is readable", async () => {
    const { SelfPlugin } = await import("../src/health/plugins/self.js");
    const { openDb } = await import("../src/db.js");
    const dbPath = join(tmpdir(), `health-test-self-${Date.now()}.sqlite`);
    const db = openDb(dbPath);
    try {
      const plugin = new SelfPlugin(db, dbPath);
      const report = await plugin.check();
      expect(report.status).toBe("green");
      expect(report.pluginName).toBe("agent-bridge");
    } finally {
      db.close();
      try { rmSync(dbPath); } catch {}
    }
  });

  it("does not call getLastUpdateId with hardcoded codex for database check", async () => {
    const { SelfPlugin } = await import("../src/health/plugins/self.js");
    const { openDb } = await import("../src/db.js");
    const dbPath = join(tmpdir(), `health-test-self-${Date.now()}.sqlite`);
    const db = openDb(dbPath);
    const spy = vi.spyOn(db, "getLastUpdateId");
    try {
      const plugin = new SelfPlugin(db, dbPath);
      await plugin.check();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      db.close();
      try { rmSync(dbPath); } catch {}
    }
  });

  it("reports red when DB file does not exist", async () => {
    const { SelfPlugin } = await import("../src/health/plugins/self.js");
    const { openDb } = await import("../src/db.js");
    const dbPath = join(tmpdir(), `health-test-self-${Date.now()}.sqlite`);
    const db = openDb(dbPath);
    db.close();
    rmSync(dbPath);
    const plugin = new SelfPlugin(db, dbPath);
    const report = await plugin.check();
    expect(report.status).toBe("red");
    const dbCheck = report.checks.find(c => c.name === "db-file");
    expect(dbCheck?.status).toBe("red");
  });

  it("includes timestamp in report", async () => {
    const { SelfPlugin } = await import("../src/health/plugins/self.js");
    const { openDb } = await import("../src/db.js");
    const dbPath = join(tmpdir(), `health-test-self-${Date.now()}.sqlite`);
    const db = openDb(dbPath);
    try {
      const plugin = new SelfPlugin(db, dbPath);
      const report = await plugin.check();
      expect(report.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    } finally {
      db.close();
      try { rmSync(dbPath); } catch {}
    }
  });

  it("includes process-memory check with numeric MB value", async () => {
    const { SelfPlugin } = await import("../src/health/plugins/self.js");
    const { openDb } = await import("../src/db.js");
    const dbPath = join(tmpdir(), `health-test-self-${Date.now()}.sqlite`);
    const db = openDb(dbPath);
    try {
      const plugin = new SelfPlugin(db, dbPath);
      const report = await plugin.check();
      const memCheck = report.checks.find(c => c.name === "process-memory");
      expect(memCheck).toBeDefined();
      expect(["green", "amber", "red"]).toContain(memCheck?.status);
      expect(typeof memCheck?.value).toBe("number");
      expect((memCheck?.value as number) > 0).toBe(true);
    } finally {
      db.close();
      try { rmSync(dbPath); } catch {}
    }
  });

  it("reports green circuit-breaker when no consecutive failures recorded", async () => {
    const { SelfPlugin } = await import("../src/health/plugins/self.js");
    const { openDb } = await import("../src/db.js");
    const dbPath = join(tmpdir(), `health-test-self-${Date.now()}.sqlite`);
    const db = openDb(dbPath);
    try {
      const plugin = new SelfPlugin(db, dbPath);
      const report = await plugin.check();
      const cbCheck = report.checks.find(c => c.name === "circuit-breaker");
      expect(cbCheck).toBeDefined();
      expect(cbCheck?.status).toBe("green");
    } finally {
      db.close();
      try { rmSync(dbPath); } catch {}
    }
  });

  it("reports red circuit-breaker when a bot has 2+ consecutive failures", async () => {
    const { SelfPlugin } = await import("../src/health/plugins/self.js");
    const { openDb } = await import("../src/db.js");
    const dbPath = join(tmpdir(), `health-test-self-${Date.now()}.sqlite`);
    const db = openDb(dbPath);
    try {
      db.incrementFailures("test-chat", "codex");
      db.incrementFailures("test-chat", "codex");
      const plugin = new SelfPlugin(db, dbPath);
      const report = await plugin.check();
      const cbCheck = report.checks.find(c => c.name === "circuit-breaker");
      expect(cbCheck?.status).toBe("red");
      expect(cbCheck?.message).toContain("codex");
    } finally {
      db.close();
      try { rmSync(dbPath); } catch {}
    }
  });
});

// ── ServerPlugin ──────────────────────────────────────────────────────────────

describe("ServerPlugin", () => {
  it("reports stats successfully", async () => {
    const oldMockExists = (globalThis as any).__mockExistsSync;
    const oldMockExec = (globalThis as any).__mockExecSync;
    (globalThis as any).__mockExistsSync = (path: string) => {
      if (path === "/usr/lib/update-notifier/apt-check") return false;
      if (path === "/var/run/reboot-required") return false;
      return oldMockExists?.(path);
    };
    (globalThis as any).__mockExecSync = (cmd: string) => {
      if (cmd.includes("ps -eo pid,pcpu,comm")) return "PID %CPU COMMAND\n1 0.1 node";
      if (cmd.includes("ps -eo state")) return "STAT\nS\nS\n";
      if (cmd.includes("systemctl is-active ufw")) return "active";
      if (cmd.includes("systemctl list-units --state=failed")) return "";
      return oldMockExec?.(cmd);
    };

    const { ServerPlugin } = await import("../src/health/plugins/server.js");
    try {
      const plugin = new ServerPlugin();
      const report = await plugin.check();
      expect(report.pluginName).toBe("server");
      expect(["green", "amber", "red"]).toContain(report.status);
      
      const cpuCheck = report.checks.find(c => c.name === "cpu-load");
      expect(cpuCheck).toBeDefined();
      expect(["green", "amber", "red"]).toContain(cpuCheck?.status);
      expect(typeof cpuCheck?.value).toBe("number");

      const memCheck = report.checks.find(c => c.name === "memory-usage");
      expect(memCheck).toBeDefined();
      expect(["green", "amber", "red"]).toContain(memCheck?.status);
      expect(typeof memCheck?.value).toBe("number");

      const swapCheck = report.checks.find(c => c.name === "swap-usage");
      expect(swapCheck).toBeDefined();
      expect(["green", "amber", "red"]).toContain(swapCheck?.status);

      const zombieCheck = report.checks.find(c => c.name === "zombies");
      expect(zombieCheck).toBeDefined();
      expect(["green", "amber", "red"]).toContain(zombieCheck?.status);
      expect(typeof zombieCheck?.value).toBe("number");

      const uptimeCheck = report.checks.find(c => c.name === "uptime");
      expect(uptimeCheck).toBeDefined();
      expect(uptimeCheck?.status).toBe("green");
      expect(typeof uptimeCheck?.value).toBe("number");

      const firewallCheck = report.checks.find(c => c.name === "firewall");
      expect(firewallCheck).toBeDefined();
      expect(["green", "amber"]).toContain(firewallCheck?.status);

      const sshKeyCheck = report.checks.find(c => c.name === "ssh-key-perms");
      expect(sshKeyCheck).toBeDefined();
      expect(["green", "amber", "red"]).toContain(sshKeyCheck?.status);

      const envFileCheck = report.checks.find(c => c.name === "env-file-perms");
      expect(envFileCheck).toBeDefined();
      expect(["green", "amber"]).toContain(envFileCheck?.status);

      const diskCheck = report.checks.find(c => c.name === "disk-space");
      expect(diskCheck).toBeDefined();
      expect(["green", "amber", "red"]).toContain(diskCheck?.status);
      expect(typeof diskCheck?.value).toBe("number");
      expect((diskCheck?.value as number) > 0).toBe(true);

      const failedSvcCheck = report.checks.find(c => c.name === "failed-services");
      expect(failedSvcCheck).toBeDefined();
      expect(["green", "amber", "red"]).toContain(failedSvcCheck?.status);
    } finally {
      (globalThis as any).__mockExistsSync = oldMockExists;
      (globalThis as any).__mockExecSync = oldMockExec;
    }
  });

  it("supports configurable CPU load thresholds", async () => {
    const { ServerPlugin } = await import("../src/health/plugins/server.js");
    // Set custom multipliers/thresholds that force it to be flagged (even if load is 0)
    process.env.HEALTH_CPU_LOAD_AMBER_MULTIPLIER = "-1.0";
    process.env.HEALTH_CPU_LOAD_RED_MULTIPLIER = "-0.5";
    process.env.HEALTH_HEAVY_LANE_DB_PATH = "/tmp/agent-bridge-test-missing-heavy-lane.db";
    const oldMockExists = (globalThis as any).__mockExistsSync;
    const oldMockExec = (globalThis as any).__mockExecSync;
    const execCalls: Array<{ cmd: string; options: any }> = [];
    (globalThis as any).__mockExistsSync = (path: string) => {
      if (path === "/usr/lib/update-notifier/apt-check") return false;
      if (path === "/var/run/reboot-required") return false;
      return oldMockExists?.(path);
    };
    (globalThis as any).__mockExecSync = (cmd: string, options: any) => {
      execCalls.push({ cmd, options });
      if (cmd.includes("ps -eo pid,pcpu,comm")) return "PID %CPU COMMAND\n1 0.1 node";
      if (cmd.includes("ps -eo state")) return "STAT\nS\nS\n";
      if (cmd.includes("systemctl is-active ufw")) return "active";
      if (cmd.includes("systemctl list-units --state=failed")) return "";
      return oldMockExec?.(cmd, options);
    };

    try {
      const plugin = new ServerPlugin();
      const report = await plugin.check();
      const cpuCheck = report.checks.find(c => c.name === "cpu-load");
      expect(["amber", "red"]).toContain(cpuCheck?.status);
      if (cpuCheck?.status !== "green" && process.platform === "linux") {
        expect(cpuCheck?.message).toContain("Top CPU processes");
      }
      const topProcessCall = execCalls.find(call => call.cmd.includes("ps -eo pid,pcpu,comm"));
      expect(topProcessCall?.options.timeout).toBeGreaterThan(0);
    } finally {
      delete process.env.HEALTH_CPU_LOAD_AMBER_MULTIPLIER;
      delete process.env.HEALTH_CPU_LOAD_RED_MULTIPLIER;
      delete process.env.HEALTH_HEAVY_LANE_DB_PATH;
      (globalThis as any).__mockExistsSync = oldMockExists;
      (globalThis as any).__mockExecSync = oldMockExec;
    }
  });

  it("supports disabling swap check via HEALTH_SWAP_MONITOR_ENABLED", { timeout: 15_000 }, async () => {
    const { ServerPlugin } = await import("../src/health/plugins/server.js");
    process.env.HEALTH_SWAP_MONITOR_ENABLED = "false";
    try {
      const plugin = new ServerPlugin();
      const report = await plugin.check();
      const swapCheck = report.checks.find(c => c.name === "swap-usage");
      expect(swapCheck).toBeDefined();
      expect(swapCheck?.status).toBe("green");
      expect(swapCheck?.message).toBe("Swap monitoring disabled");
    } finally {
      delete process.env.HEALTH_SWAP_MONITOR_ENABLED;
    }
  });

  it("keeps swap green when swap usage is above amber threshold but RAM usage is healthy", { timeout: 15_000 }, async () => {
    const { ServerPlugin } = await import("../src/health/plugins/server.js");
    process.env.HEALTH_MEMORY_AMBER_PCT = "101";
    process.env.HEALTH_SWAP_AMBER_PCT = "1";
    process.env.HEALTH_SWAP_RED_PCT = "101";
    
    const oldMockExists = (globalThis as any).__mockExistsSync;
    const oldMockRead = (globalThis as any).__mockReadFileSync;
    (globalThis as any).__mockExistsSync = (path: string) => path === "/proc/meminfo" ? true : undefined;
    (globalThis as any).__mockReadFileSync = (path: string) => {
      if (path === "/proc/meminfo") {
        return "SwapTotal:      1000000 kB\nSwapFree:        500000 kB";
      }
      return undefined;
    };

    try {
      const plugin = new ServerPlugin();
      const report = await plugin.check();
      const swapCheck = report.checks.find(c => c.name === "swap-usage");
      expect(swapCheck?.status).toBe("green");
    } finally {
      delete process.env.HEALTH_MEMORY_AMBER_PCT;
      delete process.env.HEALTH_SWAP_AMBER_PCT;
      delete process.env.HEALTH_SWAP_RED_PCT;
      (globalThis as any).__mockExistsSync = oldMockExists;
      (globalThis as any).__mockReadFileSync = oldMockRead;
    }
  });

  it("flags swap amber when swap usage is above amber threshold and RAM usage is not healthy", { timeout: 15_000 }, async () => {
    const { ServerPlugin } = await import("../src/health/plugins/server.js");
    process.env.HEALTH_MEMORY_AMBER_PCT = "1";
    process.env.HEALTH_MEMORY_RED_PCT = "101";
    process.env.HEALTH_SWAP_AMBER_PCT = "10";
    process.env.HEALTH_SWAP_RED_PCT = "101";
    
    const oldMockExists = (globalThis as any).__mockExistsSync;
    const oldMockRead = (globalThis as any).__mockReadFileSync;
    (globalThis as any).__mockExistsSync = (path: string) => path === "/proc/meminfo" ? true : undefined;
    (globalThis as any).__mockReadFileSync = (path: string) => {
      if (path === "/proc/meminfo") {
        return "SwapTotal:      1000000 kB\nSwapFree:        500000 kB";
      }
      return undefined;
    };

    try {
      const plugin = new ServerPlugin();
      const report = await plugin.check();
      const swapCheck = report.checks.find(c => c.name === "swap-usage");
      expect(swapCheck?.status).toBe("amber");
    } finally {
      delete process.env.HEALTH_MEMORY_AMBER_PCT;
      delete process.env.HEALTH_MEMORY_RED_PCT;
      delete process.env.HEALTH_SWAP_AMBER_PCT;
      delete process.env.HEALTH_SWAP_RED_PCT;
      (globalThis as any).__mockExistsSync = oldMockExists;
      (globalThis as any).__mockReadFileSync = oldMockRead;
    }
  });
});

// ── HealthScheduler ───────────────────────────────────────────────────────────

describe("HealthScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls plugin check after the configured cadence interval", async () => {
    const { HealthScheduler } = await import("../src/health/scheduler.js");
    const mockReport = {
      pluginName: "test",
      status: "green" as const,
      checks: [],
      summary: "ok",
      timestamp: new Date().toISOString(),
    };
    const mockPlugin = {
      name: "test",
      check: vi.fn().mockResolvedValue(mockReport),
    };
    const reports: string[] = [];
    const scheduler = new HealthScheduler({
      plugins: [mockPlugin],
      config: { enabled: true, cadenceSeconds: 60 },
      sendReport: async (text) => { reports.push(text); },
    });
    scheduler.start();
    expect(mockPlugin.check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockPlugin.check).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it("does not start polling when enabled is false", async () => {
    const { HealthScheduler } = await import("../src/health/scheduler.js");
    const mockPlugin = { name: "test", check: vi.fn() };
    const scheduler = new HealthScheduler({
      plugins: [mockPlugin],
      config: { enabled: false, cadenceSeconds: 10 },
      sendReport: async () => {},
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mockPlugin.check).not.toHaveBeenCalled();
    scheduler.stop();
  });

  it("stops polling after stop() is called", async () => {
    const { HealthScheduler } = await import("../src/health/scheduler.js");
    const mockReport = {
      pluginName: "test",
      status: "green" as const,
      checks: [],
      summary: "ok",
      timestamp: new Date().toISOString(),
    };
    const mockPlugin = {
      name: "test",
      check: vi.fn().mockResolvedValue(mockReport),
    };
    const scheduler = new HealthScheduler({
      plugins: [mockPlugin],
      config: { enabled: true, cadenceSeconds: 60 },
      sendReport: async () => {},
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockPlugin.check).toHaveBeenCalledTimes(1);
    scheduler.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mockPlugin.check).toHaveBeenCalledTimes(1);
  });

  it("sends formatted report via sendReport callback", async () => {
    const { HealthScheduler } = await import("../src/health/scheduler.js");
    const mockReport = {
      pluginName: "content-crawler",
      status: "green" as const,
      checks: [{ name: "queue", status: "green" as const, message: "healthy" }],
      summary: "All systems green",
      timestamp: new Date().toISOString(),
    };
    const mockPlugin = {
      name: "content-crawler",
      check: vi.fn().mockResolvedValue(mockReport),
    };
    const reports: string[] = [];
    const scheduler = new HealthScheduler({
      plugins: [mockPlugin],
      config: { enabled: true, cadenceSeconds: 60 },
      sendReport: async (text) => { reports.push(text); },
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain("content-crawler");
    expect(reports[0]).toContain("All systems green");
    scheduler.stop();
  });

  it("does not send green report to Telegram when silenceOnGreen is true", async () => {
    const { HealthScheduler } = await import("../src/health/scheduler.js");
    const greenPlugin = {
      name: "test",
      check: async () => ({
        pluginName: "test",
        status: "green" as const,
        checks: [],
        summary: "All good",
        timestamp: new Date().toISOString(),
      }),
    };
    const reports: string[] = [];
    const scheduler = new HealthScheduler({
      plugins: [greenPlugin],
      config: { enabled: true, cadenceSeconds: 60, silenceOnGreen: true },
      sendReport: async (text) => { reports.push(text); },
    });
    await scheduler.runPlugin(greenPlugin);
    expect(reports).toHaveLength(0);
  });

  it("still sends amber report when silenceOnGreen is true", async () => {
    const { HealthScheduler } = await import("../src/health/scheduler.js");
    const amberPlugin = {
      name: "test",
      check: async () => ({
        pluginName: "test",
        status: "amber" as const,
        checks: [],
        summary: "Warning",
        timestamp: new Date().toISOString(),
      }),
    };
    const reports: string[] = [];
    const scheduler = new HealthScheduler({
      plugins: [amberPlugin],
      config: { enabled: true, cadenceSeconds: 60, silenceOnGreen: true },
      sendReport: async (text) => { reports.push(text); },
    });
    await scheduler.runPlugin(amberPlugin);
    expect(reports).toHaveLength(1);
  });
});

// ── parseCadenceSeconds ───────────────────────────────────────────────────────

describe("parseCadenceSeconds", () => {
  it("returns 3600 when HEALTH_MONITOR_CADENCE_SECONDS is not set", async () => {
    const { parseCadenceSeconds } = await import("../src/health/config.js");
    expect(parseCadenceSeconds({})).toBe(3600);
  });

  it("returns parsed integer when valid", async () => {
    const { parseCadenceSeconds } = await import("../src/health/config.js");
    expect(parseCadenceSeconds({ HEALTH_MONITOR_CADENCE_SECONDS: "900" })).toBe(900);
  });

  it("returns 3600 when value is NaN", async () => {
    const { parseCadenceSeconds } = await import("../src/health/config.js");
    expect(parseCadenceSeconds({ HEALTH_MONITOR_CADENCE_SECONDS: "abc" })).toBe(3600);
  });

  it("returns 3600 when value is zero", async () => {
    const { parseCadenceSeconds } = await import("../src/health/config.js");
    expect(parseCadenceSeconds({ HEALTH_MONITOR_CADENCE_SECONDS: "0" })).toBe(3600);
  });

  it("returns 3600 when value is negative", async () => {
    const { parseCadenceSeconds } = await import("../src/health/config.js");
    expect(parseCadenceSeconds({ HEALTH_MONITOR_CADENCE_SECONDS: "-100" })).toBe(3600);
  });
});

// ── parseHealthEnabled ────────────────────────────────────────────────────────

describe("parseHealthEnabled", () => {
  it("defaults to false when HEALTH_MONITOR_ENABLED is not set", async () => {
    const { parseHealthEnabled } = await import("../src/health/config.js");
    expect(parseHealthEnabled({})).toBe(false);
  });

  it("is true when HEALTH_MONITOR_ENABLED=true", async () => {
    const { parseHealthEnabled } = await import("../src/health/config.js");
    expect(parseHealthEnabled({ HEALTH_MONITOR_ENABLED: "true" })).toBe(true);
  });

  it("is false when HEALTH_MONITOR_ENABLED=false", async () => {
    const { parseHealthEnabled } = await import("../src/health/config.js");
    expect(parseHealthEnabled({ HEALTH_MONITOR_ENABLED: "false" })).toBe(false);
  });
});

// ── integrated Telegram health mode ─────────────────────────────────────────

describe("integrated health bot mode", () => {
  it("defaults to the standalone health token and polling owner", async () => {
    const { parseHealthBotMode, resolveHealthTelegramToken, shouldHealthServicePoll } = await import("../src/health/config.js");
    expect(parseHealthBotMode({})).toBe("standalone");
    expect(resolveHealthTelegramToken({ TELEGRAM_BOT_TOKEN_HEALTH: "health-token" })).toBe("health-token");
    expect(shouldHealthServicePoll({})).toBe(true);
  });

  it("uses the interactive token and leaves polling to interactive in integrated mode", async () => {
    const { parseHealthBotMode, resolveHealthTelegramToken, shouldHealthServicePoll } = await import("../src/health/config.js");
    const env = { HEALTH_BOT_MODE: "integrated", TELEGRAM_BOT_TOKEN_INTERACTIVE: "interactive-token" };
    expect(parseHealthBotMode(env)).toBe("integrated");
    expect(resolveHealthTelegramToken(env)).toBe("interactive-token");
    expect(shouldHealthServicePoll(env)).toBe(false);
  });

  it("rejects an unknown health bot mode", async () => {
    const { parseHealthBotMode } = await import("../src/health/config.js");
    expect(() => parseHealthBotMode({ HEALTH_BOT_MODE: "shared" })).toThrow(/HEALTH_BOT_MODE/);
  });
});

// ── SelfPlugin — extended SRE checks ─────────────────────────────────────────

describe("SelfPlugin — extended checks", () => {
  let dbPath: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;

  beforeEach(async () => {
    const { openDb } = await import("../src/db.js");
    dbPath = join(tmpdir(), `health-self-ext-${Date.now()}.sqlite`);
    db = openDb(dbPath);
  });

  afterEach(() => {
    try { db.close(); } catch {}
    try { rmSync(dbPath); } catch {}
    delete (globalThis as any).__mockExecSync;
    delete (globalThis as any).__mockExecFileSync;
  });

  it("includes heap-usage check with percentage value 0–100", async () => {
    const { SelfPlugin } = await import("../src/health/plugins/self.js");
    const plugin = new SelfPlugin(db as any, dbPath);
    const report = await plugin.check();
    const heapCheck = report.checks.find(c => c.name === "heap-usage");
    expect(heapCheck).toBeDefined();
    expect(["green", "amber", "red"]).toContain(heapCheck?.status);
    expect(typeof heapCheck?.value).toBe("number");
    expect(heapCheck!.value as number).toBeGreaterThan(0);
    expect(heapCheck!.value as number).toBeLessThanOrEqual(100);
  });

  it("includes fd-count check with numeric file descriptor count on Linux", async () => {
    if (process.platform !== "linux") return;
    const { SelfPlugin } = await import("../src/health/plugins/self.js");
    const plugin = new SelfPlugin(db as any, dbPath);
    const report = await plugin.check();
    const fdCheck = report.checks.find(c => c.name === "fd-count");
    expect(fdCheck).toBeDefined();
    expect(["green", "amber", "red"]).toContain(fdCheck?.status);
    expect(typeof fdCheck?.value).toBe("number");
    expect(fdCheck!.value as number).toBeGreaterThan(0);
  });

  it("includes service-restarts check when serviceNames provided", async () => {
    const { SelfPlugin } = await import("../src/health/plugins/self.js");
    const plugin = new SelfPlugin(db as any, dbPath, ["agent-bridge-codex"]);
    const report = await plugin.check();
    const restartCheck = report.checks.find(c => c.name === "service-restarts");
    expect(restartCheck).toBeDefined();
    expect(["green", "amber", "red"]).toContain(restartCheck?.status);
    expect(typeof restartCheck?.value).toBe("number");
  });

  it("summary names specific failing checks instead of generic message", async () => {
    const { SelfPlugin } = await import("../src/health/plugins/self.js");
    const badPath = join(tmpdir(), `no-such-db-${Date.now()}.sqlite`);
    const plugin = new SelfPlugin(db as any, badPath);
    const report = await plugin.check();
    expect(report.status).toBe("red");
    expect(report.summary).toMatch(/db-file/);
  });

  it("reports appropriate status for agent CLI updates based on version distance thresholds", async () => {
    (globalThis as any).__mockExecSync = (cmd: string) => {
      if (cmd.includes("npm list -g --depth=0 --json")) {
        return JSON.stringify({
          dependencies: {
            "@anthropic-ai/claude-code": { version: "2.1.158" },
            "@openai/codex": { version: "0.135.0" }
          }
        });
      }
      if (cmd.includes("npm view @anthropic-ai/claude-code version") && !cmd.includes("versions")) {
        return "2.1.168";
      }
      if (cmd.includes("npm view @openai/codex version") && !cmd.includes("versions")) {
        return "0.137.0";
      }
      if (cmd.includes("npm view @anthropic-ai/claude-code versions --json")) {
        return JSON.stringify([
          "2.1.158", "2.1.159", "2.1.160", "2.1.161", "2.1.162",
          "2.1.163", "2.1.164", "2.1.165", "2.1.166", "2.1.167", "2.1.168"
        ]);
      }
      if (cmd.includes("npm view @openai/codex versions --json")) {
        return JSON.stringify(["0.135.0", "0.136.0", "0.137.0"]);
      }
      return undefined;
    };
    (globalThis as any).__mockExecFileSync = (command: string) => {
      if (command.includes("claude")) return "Claude Code 2.1.158";
      if (command.includes("codex")) return "codex 0.135.0";
      return "agy 1.0.10";
    };

    const { SelfPlugin } = await import("../src/health/plugins/self.js");
    const plugin = new SelfPlugin(db as any, dbPath);
    const report = await plugin.check();

    const claudeCheck = report.checks.find(c => c.name === "cli-update-claude-code");
    expect(claudeCheck).toBeDefined();
    expect(claudeCheck?.status).toBe("red"); // 10 versions behind
    expect(claudeCheck?.message).toContain("2.1.158 -> 2.1.168");
    expect(claudeCheck?.message).toContain("upgrade.sh");

    const codexCheck = report.checks.find(c => c.name === "cli-update-codex");
    expect(codexCheck).toBeDefined();
    expect(codexCheck?.status).toBe("green"); // 2 versions behind
    expect(codexCheck?.message).toContain("0.135.0 -> 0.137.0");
    expect(codexCheck?.message).toContain("upgrade.sh");

    // agy is now checked directly via agy --version, not npm outdated
    const antigravityNpmCheck = report.checks.find(c => c.name === "cli-update-antigravity");
    expect(antigravityNpmCheck).toBeUndefined();
  });

  it("reports green status when agent CLIs are up to date", async () => {
    (globalThis as any).__mockExecSync = (cmd: string) => {
      if (cmd.includes("npm list -g --depth=0 --json")) {
        return JSON.stringify({
          dependencies: {
            "@anthropic-ai/claude-code": { version: "2.1.185" },
            "@openai/codex": { version: "0.141.0" }
          }
        });
      }
      if (cmd.includes("npm view @anthropic-ai/claude-code version") && !cmd.includes("versions")) return "2.1.185";
      if (cmd.includes("npm view @openai/codex version") && !cmd.includes("versions")) return "0.141.0";
      if (cmd.includes("agy --version")) return "1.0.10";
      return undefined;
    };
    (globalThis as any).__mockExecFileSync = (command: string) => {
      if (command.includes("claude")) return "Claude Code 2.1.185";
      if (command.includes("codex")) return "codex 0.141.0";
      return "agy 1.0.10";
    };

    const { SelfPlugin } = await import("../src/health/plugins/self.js");
    const plugin = new SelfPlugin(db as any, dbPath);
    const report = await plugin.check();

    const claudeCheck = report.checks.find(c => c.name === "cli-update-claude-code");
    expect(claudeCheck).toBeDefined();
    expect(claudeCheck?.status).toBe("green");
    expect(claudeCheck?.message).toContain("up to date");

    const codexCheck = report.checks.find(c => c.name === "cli-update-codex");
    expect(codexCheck).toBeDefined();
    expect(codexCheck?.status).toBe("green");
    expect(codexCheck?.message).toContain("up to date");

    // agy checked via direct binary, not npm outdated
    const antigravityNpmCheck = report.checks.find(c => c.name === "cli-update-antigravity");
    expect(antigravityNpmCheck).toBeUndefined();

    const agyCheck = report.checks.find(c => c.name === "agy-version");
    expect(agyCheck?.status).toBe("green");
    expect(agyCheck?.message).toContain("1.0.10");
  });

  it("handles npm list errors gracefully without failing the entire plugin", async () => {
    (globalThis as any).__mockExecSync = (cmd: string) => {
      if (cmd.includes("npm list -g --depth=0 --json")) {
        throw new Error("npm command completely failed");
      }
      return undefined;
    };

    const { SelfPlugin } = await import("../src/health/plugins/self.js");
    const plugin = new SelfPlugin(db as any, dbPath);
    const report = await plugin.check();

    // The plugin check itself should succeed, but there won't be any update checks
    expect(report.status).toBe("amber");
    const claudeCheck = report.checks.find(c => c.name === "cli-update-claude-code");
    expect(claudeCheck?.status).toBe("amber");
    expect(claudeCheck?.message).toContain("npm package metadata unavailable");
  });
  it("reports agy version as green when agy is installed", async () => {
    (globalThis as any).__mockExecSync = (cmd: string) => {
      if (cmd.includes("npm list -g --depth=0 --json")) {
        return JSON.stringify({ dependencies: { "@anthropic-ai/claude-code": { version: "2.1.185" }, "@openai/codex": { version: "0.141.0" } } });
      }
      if (cmd.includes("npm view @anthropic-ai/claude-code version") && !cmd.includes("versions")) return "2.1.185";
      if (cmd.includes("npm view @openai/codex version") && !cmd.includes("versions")) return "0.141.0";
      if (cmd.includes("agy --version")) return "1.0.10";
      return undefined;
    };

    const { SelfPlugin } = await import("../src/health/plugins/self.js");
    const plugin = new SelfPlugin(db as any, dbPath);
    const report = await plugin.check();

    const agyCheck = report.checks.find(c => c.name === "agy-version");
    expect(agyCheck).toBeDefined();
    expect(agyCheck?.status).toBe("green");
    expect(agyCheck?.message).toContain("1.0.10");
  });

  it("reports agy-version as red when agy is not installed", async () => {
    (globalThis as any).__mockExecSync = (cmd: string) => {
      if (cmd.includes("npm list -g --depth=0 --json")) {
        return JSON.stringify({ dependencies: { "@anthropic-ai/claude-code": { version: "2.1.185" }, "@openai/codex": { version: "0.141.0" } } });
      }
      if (cmd.includes("npm view @anthropic-ai/claude-code version") && !cmd.includes("versions")) return "2.1.185";
      if (cmd.includes("npm view @openai/codex version") && !cmd.includes("versions")) return "0.141.0";
      if (cmd.includes("agy --version")) throw new Error("command not found: agy");
      return undefined;
    };

    const { SelfPlugin } = await import("../src/health/plugins/self.js");
    const plugin = new SelfPlugin(db as any, dbPath);
    const report = await plugin.check();

    const agyCheck = report.checks.find(c => c.name === "agy-version");
    expect(agyCheck).toBeDefined();
    expect(agyCheck?.status).toBe("red");
    expect(agyCheck?.message).toContain("not found");
  });
});

// ── ServerPlugin — extended SRE checks ───────────────────────────────────────

describe("ServerPlugin — extended checks", () => {
  it("cpu-load message includes 5m and 15m load averages", async () => {
    const { ServerPlugin } = await import("../src/health/plugins/server.js");
    const plugin = new ServerPlugin();
    const report = await plugin.check();
    const cpuCheck = report.checks.find(c => c.name === "cpu-load");
    expect(cpuCheck?.message).toMatch(/5m/i);
    expect(cpuCheck?.message).toMatch(/15m/i);
  }, 15_000);

  it("includes disk-space-tmp check for /tmp filesystem", async () => {
    const { ServerPlugin } = await import("../src/health/plugins/server.js");
    const plugin = new ServerPlugin();
    const report = await plugin.check();
    const tmpDisk = report.checks.find(c => c.name === "disk-space-tmp");
    expect(tmpDisk).toBeDefined();
    expect(["green", "amber", "red"]).toContain(tmpDisk?.status);
    expect(typeof tmpDisk?.value).toBe("number");
    expect(tmpDisk!.value as number).toBeGreaterThan(0);
  });

  it("includes disk-space-home check for home directory filesystem", async () => {
    const { ServerPlugin } = await import("../src/health/plugins/server.js");
    const plugin = new ServerPlugin();
    const report = await plugin.check();
    const homeDisk = report.checks.find(c => c.name === "disk-space-home");
    expect(homeDisk).toBeDefined();
    expect(["green", "amber", "red"]).toContain(homeDisk?.status);
    expect(typeof homeDisk?.value).toBe("number");
    expect(homeDisk!.value as number).toBeGreaterThan(0);
  });

  it("includes inode-usage check for root filesystem", async () => {
    const { ServerPlugin } = await import("../src/health/plugins/server.js");
    const plugin = new ServerPlugin();
    const report = await plugin.check();
    const inodeCheck = report.checks.find(c => c.name === "inode-usage");
    expect(inodeCheck).toBeDefined();
    expect(["green", "amber", "red"]).toContain(inodeCheck?.status);
  });

  it("supports configurable memory amber threshold via HEALTH_MEMORY_AMBER_PCT", async () => {
    process.env.HEALTH_MEMORY_AMBER_PCT = "1";
    try {
      const { ServerPlugin } = await import("../src/health/plugins/server.js");
      const plugin = new ServerPlugin();
      const report = await plugin.check();
      const memCheck = report.checks.find(c => c.name === "memory-usage");
      expect(["amber", "red"]).toContain(memCheck?.status);
    } finally {
      delete process.env.HEALTH_MEMORY_AMBER_PCT;
    }
  });

  it("includes pending-updates check and reports green when no updates", async () => {
    (globalThis as any).__mockExistsSync = (path: string) => {
      if (path === "/usr/lib/update-notifier/apt-check") return true;
      if (path === "/var/run/reboot-required") return false;
      return undefined;
    };
    (globalThis as any).__mockExecSync = (cmd: string) => {
      if (cmd === "/usr/lib/update-notifier/apt-check") {
        return Buffer.from("0;0");
      }
      return undefined;
    };

    try {
      const { ServerPlugin } = await import("../src/health/plugins/server.js");
      const plugin = new ServerPlugin();
      const report = await plugin.check();
      const check = report.checks.find(c => c.name === "pending-updates");
      expect(check).toBeDefined();
      expect(check?.status).toBe("green");
      expect(check?.message).toBe("All packages up to date");
    } finally {
      delete (globalThis as any).__mockExistsSync;
      delete (globalThis as any).__mockExecSync;
    }
  });

  it("includes pending-updates check and reports green when only regular updates available", async () => {
    (globalThis as any).__mockExistsSync = (path: string) => {
      if (path === "/usr/lib/update-notifier/apt-check") return true;
      if (path === "/var/run/reboot-required") return false;
      return undefined;
    };
    (globalThis as any).__mockExecSync = (cmd: string) => {
      if (cmd === "/usr/lib/update-notifier/apt-check") {
        return Buffer.from("5;0");
      }
      return undefined;
    };

    try {
      const { ServerPlugin } = await import("../src/health/plugins/server.js");
      const plugin = new ServerPlugin();
      const report = await plugin.check();
      const check = report.checks.find(c => c.name === "pending-updates");
      expect(check).toBeDefined();
      expect(check?.status).toBe("green");
      expect(check?.message).toBe("5 update(s) available (0 security updates)");
    } finally {
      delete (globalThis as any).__mockExistsSync;
      delete (globalThis as any).__mockExecSync;
    }
  });

  it("includes pending-updates check and reports amber when security updates available", async () => {
    (globalThis as any).__mockExistsSync = (path: string) => {
      if (path === "/usr/lib/update-notifier/apt-check") return true;
      if (path === "/var/run/reboot-required") return false;
      return undefined;
    };
    (globalThis as any).__mockExecSync = (cmd: string) => {
      if (cmd === "/usr/lib/update-notifier/apt-check") {
        return Buffer.from("12;3");
      }
      return undefined;
    };

    try {
      const { ServerPlugin } = await import("../src/health/plugins/server.js");
      const plugin = new ServerPlugin();
      const report = await plugin.check();
      const check = report.checks.find(c => c.name === "pending-updates");
      expect(check).toBeDefined();
      expect(check?.status).toBe("amber");
      expect(check?.message).toBe("12 update(s) available (3 security update(s))");
    } finally {
      delete (globalThis as any).__mockExistsSync;
      delete (globalThis as any).__mockExecSync;
    }
  });

  it("includes reboot-required check and reports green when not required", async () => {
    (globalThis as any).__mockExistsSync = (path: string) => {
      if (path === "/var/run/reboot-required") return false;
      return undefined;
    };

    try {
      const { ServerPlugin } = await import("../src/health/plugins/server.js");
      const plugin = new ServerPlugin();
      const report = await plugin.check();
      const check = report.checks.find(c => c.name === "reboot-required");
      expect(check).toBeDefined();
      expect(check?.status).toBe("green");
      expect(check?.message).toBe("No reboot required");
    } finally {
      delete (globalThis as any).__mockExistsSync;
    }
  });

  it("includes reboot-required check and reports amber when reboot is required with package list", async () => {
    (globalThis as any).__mockExistsSync = (path: string) => {
      if (path === "/var/run/reboot-required") return true;
      if (path === "/var/run/reboot-required.pkgs") return true;
      return undefined;
    };
    (globalThis as any).__mockReadFileSync = (path: string) => {
      if (path === "/var/run/reboot-required.pkgs") {
        return "linux-image-generic\nlibc6\n";
      }
      return undefined;
    };

    try {
      const { ServerPlugin } = await import("../src/health/plugins/server.js");
      const plugin = new ServerPlugin();
      const report = await plugin.check();
      const check = report.checks.find(c => c.name === "reboot-required");
      expect(check).toBeDefined();
      expect(check?.status).toBe("amber");
      expect(check?.message).toBe("Reboot required by system updates (packages: linux-image-generic, libc6)");
    } finally {
      delete (globalThis as any).__mockExistsSync;
      delete (globalThis as any).__mockReadFileSync;
    }
  });

});


// ── HealthScheduler — overlap protection ────────────────────────────────────

describe("HealthScheduler overlap protection", () => {
  it("skips running a plugin if a previous run is still in flight", async () => {
    const { HealthScheduler } = await import("../src/health/scheduler.js");
    const mockReport = {
      pluginName: "test",
      status: "green" as const,
      checks: [],
      summary: "All good",
      timestamp: new Date().toISOString(),
    };
    
    let resolveCheck: (value: typeof mockReport) => void = () => {};
    const checkPromise = new Promise<typeof mockReport>((resolve) => {
      resolveCheck = resolve;
    });

    const mockPlugin = {
      name: "test",
      check: vi.fn().mockReturnValue(checkPromise),
    };
    
    const reports: string[] = [];
    const scheduler = new HealthScheduler({
      plugins: [mockPlugin],
      config: { enabled: true, cadenceSeconds: 60 },
      sendReport: async (text) => { reports.push(text); },
    });

    // Start first run - it should remain in flight
    const run1 = scheduler.runPlugin(mockPlugin);
    
    // Start second run - it should skip
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await scheduler.runPlugin(mockPlugin);
    
    expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining("run skipped: previous run still in flight"));
    expect(mockPlugin.check).toHaveBeenCalledTimes(1); // Only called once
    
    // Resolve the first check
    resolveCheck(mockReport);
    await run1;
    
    expect(reports).toHaveLength(1);
    consoleWarnSpy.mockRestore();
  });
});

// ── Health bot delivery ──────────────────────────────────────────────────────

describe("health bot scheduled delivery", () => {
  it("uses the configured CLI bot kind for Telegram rendering", async () => {
    const { sendTelegramMessage } = await import("../src/messageDelivery.js");
    const sent: Array<{ kind: string; body: any }> = [];
    const client = { sendMessage: vi.fn(async (body) => { sent.push({ kind: "antigravity", body }); }) } as any;

    await sendTelegramMessage({
      client,
      kind: "antigravity",
      chatId: 123,
      body: { text: "```bash\nsudo systemctl restart agent-bridge-health\n```" },
    });

    expect(client.sendMessage).toHaveBeenCalledOnce();
    expect(sent[0].body.parse_mode).toBe("HTML");
    expect(sent[0].body.text).toContain("<pre");
  });
});

// ── ServerPlugin — heavy lane CPU suppression ────────────────────────────────

describe("ServerPlugin — heavy lane CPU suppression", () => {
  it("cpu-load is green when heavy lane has processing rows, even under high load", async () => {
    const { ServerPlugin } = await import("../src/health/plugins/server.js");
    process.env.HEALTH_CPU_LOAD_AMBER_MULTIPLIER = "-1.0";
    process.env.HEALTH_CPU_LOAD_RED_MULTIPLIER = "-0.5";

    const dbPath = join(tmpdir(), `heavy-lane-active-${Date.now()}.sqlite`);
    const BetterSqlite3 = (await import("better-sqlite3")).default;
    const db = new BetterSqlite3(dbPath);
    db.exec(`CREATE TABLE queue_items (id INTEGER PRIMARY KEY, status TEXT NOT NULL, lane TEXT)`);
    db.prepare("INSERT INTO queue_items (status, lane) VALUES ('processing', 'heavy')").run();
    db.close();

    process.env.HEALTH_HEAVY_LANE_DB_PATH = dbPath;
    const oldMockExists = (globalThis as any).__mockExistsSync;
    const oldMockExec = (globalThis as any).__mockExecSync;
    (globalThis as any).__mockExistsSync = (path: string) => {
      if (path === "/usr/lib/update-notifier/apt-check") return false;
      if (path === "/var/run/reboot-required") return false;
      return oldMockExists?.(path);
    };
    (globalThis as any).__mockExecSync = (cmd: string) => {
      if (cmd.includes("ps -eo state")) return "STAT\nS\n";
      if (cmd.includes("systemctl is-active ufw")) return "active";
      if (cmd.includes("systemctl list-units --state=failed")) return "";
      return oldMockExec?.(cmd);
    };

    try {
      const plugin = new ServerPlugin();
      const report = await plugin.check();
      const cpuCheck = report.checks.find(c => c.name === "cpu-load");
      expect(cpuCheck?.status).toBe("green");
      expect(cpuCheck?.message).toContain("heavy lane active");
    } finally {
      delete process.env.HEALTH_CPU_LOAD_AMBER_MULTIPLIER;
      delete process.env.HEALTH_CPU_LOAD_RED_MULTIPLIER;
      delete process.env.HEALTH_HEAVY_LANE_DB_PATH;
      (globalThis as any).__mockExistsSync = oldMockExists;
      (globalThis as any).__mockExecSync = oldMockExec;
      try { rmSync(dbPath); } catch {}
    }
  });

  it("cpu-load uses normal thresholds when heavy lane DB does not exist", async () => {
    const { ServerPlugin } = await import("../src/health/plugins/server.js");
    process.env.HEALTH_CPU_LOAD_AMBER_MULTIPLIER = "-1.0";
    process.env.HEALTH_CPU_LOAD_RED_MULTIPLIER = "-0.5";
    process.env.HEALTH_HEAVY_LANE_DB_PATH = "/tmp/no-such-heavy-lane-db-xyz.sqlite";

    const oldMockExists = (globalThis as any).__mockExistsSync;
    const oldMockExec = (globalThis as any).__mockExecSync;
    (globalThis as any).__mockExistsSync = (path: string) => {
      if (path === "/usr/lib/update-notifier/apt-check") return false;
      if (path === "/var/run/reboot-required") return false;
      if (path === "/tmp/no-such-heavy-lane-db-xyz.sqlite") return false;
      return oldMockExists?.(path);
    };
    (globalThis as any).__mockExecSync = (cmd: string) => {
      if (cmd.includes("ps -eo pid,pcpu,comm")) return "PID %CPU COMMAND\n1 0.1 node";
      if (cmd.includes("ps -eo state")) return "STAT\nS\n";
      if (cmd.includes("systemctl is-active ufw")) return "active";
      if (cmd.includes("systemctl list-units --state=failed")) return "";
      return oldMockExec?.(cmd);
    };

    try {
      const plugin = new ServerPlugin();
      const report = await plugin.check();
      const cpuCheck = report.checks.find(c => c.name === "cpu-load");
      expect(["amber", "red"]).toContain(cpuCheck?.status);
    } finally {
      delete process.env.HEALTH_CPU_LOAD_AMBER_MULTIPLIER;
      delete process.env.HEALTH_CPU_LOAD_RED_MULTIPLIER;
      delete process.env.HEALTH_HEAVY_LANE_DB_PATH;
      (globalThis as any).__mockExistsSync = oldMockExists;
      (globalThis as any).__mockExecSync = oldMockExec;
    }
  });

  it("cpu-load uses normal thresholds when heavy lane has no processing rows", async () => {
    const { ServerPlugin } = await import("../src/health/plugins/server.js");
    process.env.HEALTH_CPU_LOAD_AMBER_MULTIPLIER = "-1.0";
    process.env.HEALTH_CPU_LOAD_RED_MULTIPLIER = "-0.5";

    const dbPath = join(tmpdir(), `heavy-lane-empty-${Date.now()}.sqlite`);
    const BetterSqlite3 = (await import("better-sqlite3")).default;
    const db = new BetterSqlite3(dbPath);
    db.exec(`CREATE TABLE queue_items (id INTEGER PRIMARY KEY, status TEXT NOT NULL, lane TEXT)`);
    db.prepare("INSERT INTO queue_items (status, lane) VALUES ('queued', 'heavy')").run();
    db.close();

    process.env.HEALTH_HEAVY_LANE_DB_PATH = dbPath;
    const oldMockExists = (globalThis as any).__mockExistsSync;
    const oldMockExec = (globalThis as any).__mockExecSync;
    (globalThis as any).__mockExistsSync = (path: string) => {
      if (path === "/usr/lib/update-notifier/apt-check") return false;
      if (path === "/var/run/reboot-required") return false;
      return oldMockExists?.(path);
    };
    (globalThis as any).__mockExecSync = (cmd: string) => {
      if (cmd.includes("ps -eo pid,pcpu,comm")) return "PID %CPU COMMAND\n1 0.1 node";
      if (cmd.includes("ps -eo state")) return "STAT\nS\n";
      if (cmd.includes("systemctl is-active ufw")) return "active";
      if (cmd.includes("systemctl list-units --state=failed")) return "";
      return oldMockExec?.(cmd);
    };

    try {
      const plugin = new ServerPlugin();
      const report = await plugin.check();
      const cpuCheck = report.checks.find(c => c.name === "cpu-load");
      expect(["amber", "red"]).toContain(cpuCheck?.status);
    } finally {
      delete process.env.HEALTH_CPU_LOAD_AMBER_MULTIPLIER;
      delete process.env.HEALTH_CPU_LOAD_RED_MULTIPLIER;
      delete process.env.HEALTH_HEAVY_LANE_DB_PATH;
      (globalThis as any).__mockExistsSync = oldMockExists;
      (globalThis as any).__mockExecSync = oldMockExec;
      try { rmSync(dbPath); } catch {}
    }
  });
});
