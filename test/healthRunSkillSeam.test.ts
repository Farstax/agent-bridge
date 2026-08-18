import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

function source(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

describe("health investigation uses ordinary Run + native skill", () => {
  it("hands a red observation to the health-troubleshooting skill without granting authority", async () => {
    const ingress = await import("../src/health/eventIngress.js");
    const buildPrompt = (ingress as typeof ingress & {
      buildHealthOpsPrompt?: (report: {
        pluginName: string;
        status: "red";
        checks: Array<{ name: string; status: "red"; message: string }>;
        summary: string;
        timestamp: string;
      }) => string;
    }).buildHealthOpsPrompt;

    expect(buildPrompt).toBeTypeOf("function");
    const prompt = buildPrompt!({
      pluginName: "server",
      status: "red",
      checks: [{ name: "disk-space", status: "red", message: "2% free" }],
      summary: "disk critically low",
      timestamp: "2026-08-18T09:00:00.000Z",
    });

    expect(prompt).toContain("Investigate this health observation using the `health-troubleshooting` skill.");
    expect(prompt).toContain("health:report-only");
    expect(prompt).toContain("does not grant deploy, restart, or repository-mutation authority");
  });

  it("ships one provider-neutral health troubleshooting skill", () => {
    const skillDir = join(ROOT, "skills", "health-troubleshooting");
    expect(existsSync(join(skillDir, "SKILL.md"))).toBe(true);
    expect(existsSync(join(skillDir, "skill.json"))).toBe(true);

    const skill = source("skills/health-troubleshooting/SKILL.md");
    expect(skill).toContain("observation");
    expect(skill).toContain("inference");
    expect(skill).toContain("root cause");
    expect(skill).toContain("authority");
    expect(skill).toContain("verify");
  });

  it("removes health-owned provider invocation and AI session machinery", () => {
    expect(existsSync(join(ROOT, "src/health/suggest.ts"))).toBe(false);
    expect(existsSync(join(ROOT, "src/health/bot.ts"))).toBe(false);
    expect(existsSync(join(ROOT, "src/health/context.ts"))).toBe(false);

    expect(source("src/health/scheduler.ts")).not.toMatch(/generateSuggestion|suggestFn|formatSuggestion/);
    expect(source("src/health/config.ts")).not.toMatch(/HEALTH_SUGGEST_|HEALTH_CLI_|parseHealthCliConfig|resolveHealthEngineExecutionMode/);
    expect(source("src/index-health.ts")).not.toMatch(/HEALTH_MONITOR_AUTONOMY|HEALTH_SESSION_TTL|HealthBridgeBot|HealthContextStore/);
  });
});
