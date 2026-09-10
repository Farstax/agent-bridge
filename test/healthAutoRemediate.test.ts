import { describe, it, expect, vi, beforeEach } from "vitest";
import type { HealthReport } from "../src/health/types.js";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

const makeReport = (overrides: Partial<HealthReport> = {}): HealthReport => ({
  pluginName: "agent-bridge",
  status: "amber",
  checks: [{ name: "cli-update-claude-code", status: "amber", message: "update available" }],
  summary: "CLI update available",
  timestamp: new Date().toISOString(),
  ...overrides,
});

describe("autoUpdateClis", () => {
  let execFileSync: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    const cp = await import("node:child_process");
    execFileSync = (cp as any).execFileSync as ReturnType<typeof vi.fn>;
    execFileSync.mockReset();
  });

  it("does not run upgrade script when all cli-update checks are green", async () => {
    const { autoUpdateClis } = await import("../src/health/autoRemediate.js");
    const notifications: string[] = [];
    await autoUpdateClis(
      makeReport({
        status: "green",
        checks: [
          { name: "cli-update-claude-code", status: "green", message: "up to date" },
          { name: "cli-update-codex", status: "green", message: "up to date" },
        ],
      }),
      { upgradeScript: "/fake/upgrade.sh", sendNotification: async t => { notifications.push(t); } }
    );
    expect(execFileSync).not.toHaveBeenCalled();
    expect(notifications).toHaveLength(0);
  });

  it("does not run for non-agent-bridge plugin reports", async () => {
    const { autoUpdateClis } = await import("../src/health/autoRemediate.js");
    const notifications: string[] = [];
    await autoUpdateClis(
      makeReport({ pluginName: "server" }),
      { upgradeScript: "/fake/upgrade.sh", sendNotification: async t => { notifications.push(t); } }
    );
    expect(execFileSync).not.toHaveBeenCalled();
    expect(notifications).toHaveLength(0);
  });

  it("runs upgrade script with --clis-only when a cli-update check is amber", async () => {
    execFileSync.mockReturnValue("updated: @anthropic-ai/claude-code 2.1.180→2.1.185\n");
    const { autoUpdateClis } = await import("../src/health/autoRemediate.js");
    const notifications: string[] = [];
    await autoUpdateClis(
      makeReport(),
      { upgradeScript: "/path/to/upgrade.sh", sendNotification: async t => { notifications.push(t); } }
    );
    expect(execFileSync).toHaveBeenCalledWith(
      "bash",
      ["/path/to/upgrade.sh", "--clis-only"],
      expect.objectContaining({ encoding: "utf8" })
    );
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toContain("@anthropic-ai/claude-code");
    expect(notifications[0]).toContain("2.1.185");
  });

  it("does not try to update the bundled Codex ACP adapter outside a release", async () => {
    const { autoUpdateClis } = await import("../src/health/autoRemediate.js");
    const notifications: string[] = [];
    await autoUpdateClis(
      makeReport({
        checks: [{ name: "cli-update-codex", status: "red", message: "severely outdated" }],
      }),
      { upgradeScript: "/path/to/upgrade.sh", sendNotification: async t => { notifications.push(t); } }
    );
    expect(execFileSync).not.toHaveBeenCalled();
    expect(notifications).toHaveLength(0);
  });

  it("sends error notification when upgrade script throws", async () => {
    execFileSync.mockImplementation(() => { throw new Error("npm install failed"); });
    const { autoUpdateClis } = await import("../src/health/autoRemediate.js");
    const notifications: string[] = [];
    await autoUpdateClis(
      makeReport(),
      { upgradeScript: "/path/to/upgrade.sh", sendNotification: async t => { notifications.push(t); } }
    );
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toContain("failed");
    expect(notifications[0]).toContain("npm install failed");
  });

  it("updates the external Claude runtime while leaving bundled Codex to release management", async () => {
    execFileSync.mockReturnValue("updated: @anthropic-ai/claude-code 2.1.180→2.1.185\n");
    const { autoUpdateClis } = await import("../src/health/autoRemediate.js");
    const notifications: string[] = [];
    await autoUpdateClis(
      makeReport({
        checks: [
          { name: "cli-update-claude-code", status: "amber", message: "update available" },
          { name: "cli-update-codex", status: "amber", message: "update available" },
        ],
      }),
      { upgradeScript: "/path/to/upgrade.sh", sendNotification: async t => { notifications.push(t); } }
    );
    expect(notifications[0]).toContain("@anthropic-ai/claude-code");
    expect(notifications[0]).not.toContain("@openai/codex");
  });

  it("sends no notification when script output has no updated lines", async () => {
    execFileSync.mockReturnValue("no-op: CLIs already up to date\n");
    const { autoUpdateClis } = await import("../src/health/autoRemediate.js");
    const notifications: string[] = [];
    await autoUpdateClis(
      makeReport(),
      { upgradeScript: "/path/to/upgrade.sh", sendNotification: async t => { notifications.push(t); } }
    );
    expect(notifications).toHaveLength(0);
  });
});
