import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { HealthReport } from "../src/health/types.js";
import { PROVIDER_CONTRACT_VERSION, writeQualificationRecord } from "../src/providers/qualification.js";
import { formatQualificationSummary } from "../src/providers/qualificationStatus.js";

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
