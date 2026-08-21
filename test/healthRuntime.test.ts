import { describe, expect, it, vi } from "vitest";

const report = {
  pluginName: "agent-bridge",
  status: "red" as const,
  checks: [{ name: "cli-update-codex", status: "red" as const, message: "update available" }],
  summary: "CLI update available",
  timestamp: new Date().toISOString(),
};

vi.mock("../src/health/plugins/self.js", () => ({
  SelfPlugin: class {
    async check() { return report; }
  },
}));
vi.mock("../src/health/plugins/server.js", () => ({
  ServerPlugin: class {
    async check() { return { ...report, pluginName: "server", status: "green", checks: [], summary: "ok" }; }
  },
}));
vi.mock("../src/health/reports.js", () => ({
  HealthReportStore: class {
    saveReport = vi.fn();
    getAggregate = vi.fn(() => ({ status: null, reports: [], nonGreenReports: [], evidence: { missingPluginNames: [], stalePluginNames: [] } }));
  },
}));

describe("integrated health runtime", () => {
  it("runs report remediation for interactive health checks", async () => {
    const { createHealthRuntime } = await import("../src/health/runtime.js");
    const onReport = vi.fn(async () => {});
    const runtime = createHealthRuntime({
      bridgeDb: {} as any,
      dbPath: "/tmp/health.sqlite",
      env: { HEALTH_SERVER_MONITOR_ENABLED: "0" },
      chatId: 42,
      sendText: async () => {},
      onReport,
    });

    await runtime.runChecks();

    expect(onReport).toHaveBeenCalledWith(report, expect.any(Function));
  });
});
