import { describe, expect, it } from "vitest";
import { runDoctor } from "../../src/providers/doctor.js";

const allFound = () => true;
const noneFound = () => false;

describe("doctor diagnostics", () => {
  it("reports provider commands as available when the executable resolves", () => {
    const report = runDoctor({ env: {}, commandExists: allFound });
    for (const p of report.providers) {
      expect(p.status).toBe("available");
    }
  });

  it("reports provider commands as missing when the executable does not resolve", () => {
    const report = runDoctor({
      env: { INTERACTIVE_CLI_CHAIN: "codex,claude,antigravity,kimchi" },
      commandExists: noneFound,
    });
    expect(report.providers.length).toBeGreaterThan(0);
    for (const p of report.providers) {
      expect(p.status).toBe("missing");
    }
    expect(report.ok).toBe(false);
  });

  it("fails when providers referenced by unset runtime defaults are missing", () => {
    const report = runDoctor({ env: {}, commandExists: noneFound });

    expect(report.chains.find((chain) => chain.name === "INTERACTIVE_CLI_CHAIN")?.entries)
      .toEqual(["codex", "claude", "antigravity", "kimchi"]);
    expect(report.ok).toBe(false);
  });

  it("does not fail for a missing provider that no configured chain uses", () => {
    const report = runDoctor({
      env: {
        INTERACTIVE_CLI_CHAIN: "codex",
        INTERACTIVE_CLI_CHAIN: "codex",
      },
      commandExists: (executable) => executable === "codex",
    });

    expect(report.providers.find((p) => p.id === "kimchi")?.status).toBe("missing");
    expect(report.ok).toBe(true);
  });

  it("fails when a configured provider executable is missing", () => {
    const report = runDoctor({
      env: { INTERACTIVE_CLI_CHAIN: "antigravity" },
      commandExists: (executable) => executable !== "agy",
    });

    expect(report.providers.find((p) => p.id === "agy")?.status).toBe("missing");
    expect(report.ok).toBe(false);
  });

  it("accepts a parseable fallback chain", () => {
    const report = runDoctor({
      env: { INTERACTIVE_CLI_CHAIN: "codex,claude,antigravity" },
      commandExists: allFound,
    });
    const chain = report.chains.find((c) => c.name === "INTERACTIVE_CLI_CHAIN");
    expect(chain?.ok).toBe(true);
    expect(chain?.entries).toEqual(["codex", "claude", "antigravity"]);
  });

  it("flags unknown entries in a fallback chain", () => {
    const report = runDoctor({
      env: { INTERACTIVE_CLI_CHAIN: "codex,not-a-cli" },
      commandExists: allFound,
    });
    const chain = report.chains.find((c) => c.name === "INTERACTIVE_CLI_CHAIN");
    expect(chain?.ok).toBe(false);
    expect(chain?.unknown).toContain("not-a-cli");
    expect(report.ok).toBe(false);
  });

  it("skips unset chains without failing", () => {
    const report = runDoctor({ env: {}, commandExists: allFound });
    for (const chain of report.chains) {
      expect(chain.ok).toBe(true);
    }
  });

  it("reports required env entries when requested", () => {
    const report = runDoctor({
      env: { TELEGRAM_BOT_TOKEN: "x" },
      requiredEnv: ["TELEGRAM_BOT_TOKEN", "MISSING_VAR"],
      commandExists: allFound,
    });
    expect(report.env.find((e) => e.name === "TELEGRAM_BOT_TOKEN")?.present).toBe(true);
    expect(report.env.find((e) => e.name === "MISSING_VAR")?.present).toBe(false);
    expect(report.ok).toBe(false);
  });

  it("is ok when providers exist, chains parse, and env is present", () => {
    const report = runDoctor({
      env: { INTERACTIVE_CLI_CHAIN: "codex,claude" },
      commandExists: allFound,
    });
    expect(report.ok).toBe(true);
  });
});
