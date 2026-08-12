import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { HealthReport } from "../src/health/types.js";
import { PROVIDER_CONTRACT_VERSION, writeQualificationRecord } from "../src/providers/qualification.js";
import { formatQualificationSummary, readInstalledProviderVersions } from "../src/providers/qualificationStatus.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn() };
});

const report: HealthReport = {
  pluginName: "agent-bridge",
  status: "amber",
  checks: [{ name: "cli-update-codex", status: "amber", message: "update available" }],
  summary: "CLI update available",
  timestamp: "2026-08-10T17:00:00.000Z",
};

describe("provider qualification health integration", () => {
  it("uses the active Claude executable version when package metadata is newer", async () => {
    const root = mkdtempSync(join(tmpdir(), "qualification-health-runtime-"));
    const claude = join(root, "claude");
    writeFileSync(claude, "#!/usr/bin/env bash\nif [ \"$1\" = \"--version\" ]; then echo 'Claude Code 2.1.228'; else exit 1; fi\n", { mode: 0o755 });
    const cp = await import("node:child_process");
    vi.mocked(cp.execFileSync).mockReturnValue("Claude Code 2.1.228\n" as never);
    const previous = process.env.CLAUDE_COMMAND;
    process.env.CLAUDE_COMMAND = claude;
    try {
      expect(readInstalledProviderVersions().claude).toBe("2.1.228");
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_COMMAND;
      else process.env.CLAUDE_COMMAND = previous;
    }
  });

  it("sends a one-time upgrade notification when machine-readable qualification is degraded", async () => {
    const cp = await import("node:child_process");
    const execFileSync = vi.mocked(cp.execFileSync);
    execFileSync.mockReturnValue([
      "updated: @openai/codex 0.140.0→0.141.0",
      JSON.stringify({
        ran: true,
        provider: "codex",
        providerVersion: "0.141.0",
        overall: "fail",
        checks: [
          { name: "version", status: "pass" },
          { name: "fresh_prompt", status: "fail" },
        ],
      }),
      "",
    ].join("\n") as never);
    const { autoUpdateClis } = await import("../src/health/autoRemediate.js");
    const notifications: string[] = [];

    await autoUpdateClis(report, {
      upgradeScript: "/fake/upgrade.sh",
      sendNotification: async (text) => { notifications.push(text); },
      qualificationEvidencePath: join(mkdtempSync(join(tmpdir(), "qualification-health-missing-")), "missing.json"),
    });

    expect(notifications).toHaveLength(2);
    expect(notifications[0]).toContain("CLI auto-updated");
    expect(notifications[1]).toContain("CLI qualification fail");
    expect(notifications[1]).toContain("codex 0.141.0");
    expect(notifications[1]).toContain("fresh_prompt");
  });

  it("alerts once when qualification evidence is unreadable", async () => {
    const root = mkdtempSync(join(tmpdir(), "qualification-health-unreadable-"));
    const evidencePath = join(root, "qualification.json");
    writeFileSync(evidencePath, "{not-json\n", "utf8");
    const { autoUpdateClis } = await import("../src/health/autoRemediate.js");
    const notifications: string[] = [];
    const healthyReport: HealthReport = {
      ...report,
      status: "green",
      checks: [],
      summary: "healthy",
    };
    const options = {
      upgradeScript: "/fake/upgrade.sh",
      sendNotification: async (text: string) => { notifications.push(text); },
      qualificationEvidencePath: evidencePath,
    };

    await autoUpdateClis(healthyReport, options);
    await autoUpdateClis(healthyReport, options);

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toContain("CLI qualification evidence unreadable");
  });

  it("formats persistent current and stale qualification states for on-demand health", () => {
    const root = mkdtempSync(join(tmpdir(), "qualification-health-summary-"));
    const evidencePath = join(root, "qualification.json");
    writeQualificationRecord({
      provider: "agy",
      providerVersion: "1.1.12",
      previousVersion: "1.1.11",
      bridgeCommit: "d".repeat(40),
      contractVersion: PROVIDER_CONTRACT_VERSION,
      qualifiedAt: "2026-08-10T17:00:00.000Z",
      environment: "managed-appliance",
      overall: "fail",
      checks: [
        { name: "version", status: "pass" },
        { name: "fresh_prompt", status: "fail", diagnostic: "ERROR envelope included a response" },
        { name: "session_resume", status: "not_applicable" },
      ],
    }, evidencePath);

    expect(formatQualificationSummary(evidencePath, { agy: "1.1.12" })).toMatch(/agy 1\.1\.12 degraded — fresh_prompt/);
    expect(formatQualificationSummary(evidencePath, { agy: "1.1.13" })).toMatch(/agy 1\.1\.13 unqualified/);
  });
});
