import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterAll, afterEach } from "vitest";
import { resolveTimeoutsForKind } from "../src/timeouts.js";
import { buildExecutionOptions } from "../src/cli.js";
import { CliTimeoutError } from "../src/cliSupervisor.js";

const cliTestCwd = mkdtempSync(join(tmpdir(), "agent-bridge-timeout-tests-"));
afterAll(() => rmSync(cliTestCwd, { recursive: true, force: true }));

// Save and restore env after each test
const savedEnv: Record<string, string | undefined> = {};
function setEnv(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) {
    savedEnv[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  Object.keys(savedEnv).forEach((k) => delete savedEnv[k]);
});

describe("resolveTimeoutsForKind — built-in defaults", () => {
  it("all kinds get a 15-minute recoverable idle threshold by default", () => {
    setEnv({ CODEX_CLI_IDLE_TIMEOUT_MS: undefined, ANTIGRAVITY_CLI_IDLE_TIMEOUT_MS: undefined, CLAUDE_CLI_IDLE_TIMEOUT_MS: undefined, CLI_IDLE_TIMEOUT_MS: undefined });
    expect(resolveTimeoutsForKind("codex").cliIdleTimeoutMs).toBe(15 * 60_000);
    expect(resolveTimeoutsForKind("antigravity").cliIdleTimeoutMs).toBe(15 * 60_000);
    expect(resolveTimeoutsForKind("claude").cliIdleTimeoutMs).toBe(15 * 60_000);
  });

  it("all kinds get hard timeout disabled (0) by default", () => {
    setEnv({ CODEX_CLI_TIMEOUT_MS: undefined, ANTIGRAVITY_CLI_TIMEOUT_MS: undefined, CLAUDE_CLI_TIMEOUT_MS: undefined, CLI_TIMEOUT_MS: undefined });
    expect(resolveTimeoutsForKind("codex").cliTimeoutMs).toBe(0);
    expect(resolveTimeoutsForKind("antigravity").cliTimeoutMs).toBe(0);
    expect(resolveTimeoutsForKind("claude").cliTimeoutMs).toBe(0);
  });

  it("fetch timeout defaults to 45s", () => {
    setEnv({ TELEGRAM_FETCH_TIMEOUT_MS: undefined, FETCH_TIMEOUT_MS: undefined });
    expect(resolveTimeoutsForKind("antigravity").fetchTimeoutMs).toBe(45_000);
  });
});

describe("resolveTimeoutsForKind — env precedence", () => {
  it("per-CLI env var overrides global env var", () => {
    setEnv({ ANTIGRAVITY_CLI_IDLE_TIMEOUT_MS: "99000", CLI_IDLE_TIMEOUT_MS: "55000" });
    expect(resolveTimeoutsForKind("antigravity").cliIdleTimeoutMs).toBe(99_000);
  });

  it("global env var overrides built-in default", () => {
    setEnv({ ANTIGRAVITY_CLI_IDLE_TIMEOUT_MS: undefined, CLI_IDLE_TIMEOUT_MS: "55000" });
    expect(resolveTimeoutsForKind("antigravity").cliIdleTimeoutMs).toBe(55_000);
  });

  it("per-CLI env var does not affect other kinds", () => {
    setEnv({ ANTIGRAVITY_CLI_IDLE_TIMEOUT_MS: "99000", CODEX_CLI_IDLE_TIMEOUT_MS: undefined, CLI_IDLE_TIMEOUT_MS: undefined });
    expect(resolveTimeoutsForKind("codex").cliIdleTimeoutMs).toBe(15 * 60_000);
  });

  it("global CLI_TIMEOUT_MS applies to all kinds when no per-CLI override", () => {
    setEnv({ CODEX_CLI_TIMEOUT_MS: undefined, ANTIGRAVITY_CLI_TIMEOUT_MS: undefined, CLAUDE_CLI_TIMEOUT_MS: undefined, CLI_TIMEOUT_MS: "120000" });
    expect(resolveTimeoutsForKind("codex").cliTimeoutMs).toBe(120_000);
    expect(resolveTimeoutsForKind("antigravity").cliTimeoutMs).toBe(120_000);
    expect(resolveTimeoutsForKind("claude").cliTimeoutMs).toBe(120_000);
  });

  it("per-CLI hard timeout overrides global for that kind only", () => {
    setEnv({ CODEX_CLI_TIMEOUT_MS: "200000", ANTIGRAVITY_CLI_TIMEOUT_MS: undefined, CLI_TIMEOUT_MS: "120000" });
    expect(resolveTimeoutsForKind("codex").cliTimeoutMs).toBe(200_000);
    expect(resolveTimeoutsForKind("antigravity").cliTimeoutMs).toBe(120_000);
  });

  it("TELEGRAM_FETCH_TIMEOUT_MS overrides FETCH_TIMEOUT_MS", () => {
    setEnv({ TELEGRAM_FETCH_TIMEOUT_MS: "30000", FETCH_TIMEOUT_MS: "99000" });
    expect(resolveTimeoutsForKind("codex").fetchTimeoutMs).toBe(30_000);
  });

  it("FETCH_TIMEOUT_MS is honoured when TELEGRAM_FETCH_TIMEOUT_MS is absent", () => {
    setEnv({ TELEGRAM_FETCH_TIMEOUT_MS: undefined, FETCH_TIMEOUT_MS: "60000" });
    expect(resolveTimeoutsForKind("antigravity").fetchTimeoutMs).toBe(60_000);
  });

  it("ignores non-numeric values and falls back to the built-in default", () => {
    setEnv({ ANTIGRAVITY_CLI_IDLE_TIMEOUT_MS: "not-a-number", CLI_IDLE_TIMEOUT_MS: undefined });
    expect(resolveTimeoutsForKind("antigravity").cliIdleTimeoutMs).toBe(15 * 60_000);
    setEnv({ ANTIGRAVITY_CLI_TIMEOUT_MS: "not-a-number", CLI_TIMEOUT_MS: undefined });
    expect(resolveTimeoutsForKind("antigravity").cliTimeoutMs).toBe(0);
  });

  it("explicit 0 disables the idle timeout, per-CLI or global", () => {
    setEnv({ ANTIGRAVITY_CLI_IDLE_TIMEOUT_MS: "0", CLI_IDLE_TIMEOUT_MS: undefined });
    expect(resolveTimeoutsForKind("antigravity").cliIdleTimeoutMs).toBe(0);
    setEnv({ ANTIGRAVITY_CLI_IDLE_TIMEOUT_MS: undefined, CLI_IDLE_TIMEOUT_MS: "0" });
    expect(resolveTimeoutsForKind("antigravity").cliIdleTimeoutMs).toBe(0);
  });

  it("explicit 0 disables the hard timeout, per-CLI or global", () => {
    setEnv({ ANTIGRAVITY_CLI_TIMEOUT_MS: "0", CLI_TIMEOUT_MS: undefined });
    expect(resolveTimeoutsForKind("antigravity").cliTimeoutMs).toBe(0);
    setEnv({ ANTIGRAVITY_CLI_TIMEOUT_MS: undefined, CLI_TIMEOUT_MS: "0" });
    expect(resolveTimeoutsForKind("antigravity").cliTimeoutMs).toBe(0);
  });

  it("a positive per-CLI value still overrides an explicit global 0", () => {
    setEnv({ ANTIGRAVITY_CLI_TIMEOUT_MS: "5000", CLI_TIMEOUT_MS: "0" });
    expect(resolveTimeoutsForKind("antigravity").cliTimeoutMs).toBe(5_000);
  });
});

describe("buildExecutionOptions", () => {
  it("returns per-kind timeouts from resolveTimeoutsForKind", () => {
    setEnv({
      ANTIGRAVITY_CLI_IDLE_TIMEOUT_MS: undefined,
      CLI_IDLE_TIMEOUT_MS: undefined,
      ANTIGRAVITY_CLI_TIMEOUT_MS: undefined,
      CLI_TIMEOUT_MS: undefined,
    });
    const opts = buildExecutionOptions("antigravity");
    expect(opts.idleTimeoutMs).toBe(15 * 60_000);
    expect(opts.timeoutMs).toBe(0);
  });

  it("reflects env overrides at call time", () => {
    setEnv({ CODEX_CLI_IDLE_TIMEOUT_MS: "77000", CLI_IDLE_TIMEOUT_MS: undefined });
    expect(buildExecutionOptions("codex").idleTimeoutMs).toBe(77_000);
  });
});

describe("idle timeout fires on silence (integration)", () => {
  it("rejects with idle timeout label when process produces no output", async () => {
    const { runCliAsync } = await import("../src/cli.js");
    await expect(
      runCliAsync("bash", ["-lc", "sleep 5"], cliTestCwd, {
        timeoutMs: 2000,
        idleTimeoutMs: 80,
        killGraceMs: 25,
      }),
    ).rejects.toThrow(/idle timeout/i);
  }, 5000);

  it("rejects with a structured CliTimeoutError (kind: idle), not just a message-matched Error", async () => {
    const { runCliAsync } = await import("../src/cli.js");
    let caught: unknown;
    try {
      await runCliAsync("bash", ["-lc", "sleep 5"], cliTestCwd, {
        timeoutMs: 2000, idleTimeoutMs: 80, killGraceMs: 25,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CliTimeoutError);
    expect((caught as CliTimeoutError).timeoutKind).toBe("idle");
  }, 5000);

  it("rejects with a structured CliTimeoutError (kind: hard) when the hard timeout fires", async () => {
    const { runCliAsync } = await import("../src/cli.js");
    let caught: unknown;
    try {
      await runCliAsync(
        "bash", ["-lc", "for i in 1 2 3 4 5; do echo tick; sleep 0.1; done; sleep 5"],
        cliTestCwd,
        { timeoutMs: 300, idleTimeoutMs: 0, killGraceMs: 25 },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CliTimeoutError);
    expect((caught as CliTimeoutError).timeoutKind).toBe("hard");
  }, 5000);

  it("does not idle-timeout when process emits regular output", async () => {
    const { runCliAsync } = await import("../src/cli.js");
    const result = await runCliAsync(
      "bash", ["-lc", "for i in 1 2 3; do echo $i; sleep 0.1; done"],
      cliTestCwd,
      { timeoutMs: 5000, idleTimeoutMs: 1000, killGraceMs: 25 },
    );
    expect(result.text).toContain("3");
  }, 5000);

  it("idleTimeoutMs: 0 disables the idle timeout — silent process is not killed", async () => {
    const { runCliAsync } = await import("../src/cli.js");
    const result = await runCliAsync(
      "bash", ["-lc", "sleep 0.3; echo done"],
      cliTestCwd,
      { timeoutMs: 5000, idleTimeoutMs: 0, killGraceMs: 25 },
    );
    expect(result.text).toContain("done");
  }, 5000);

  it("timeoutMs: 0 disables the hard timeout — long-running process is not killed", async () => {
    const { runCliAsync } = await import("../src/cli.js");
    const result = await runCliAsync(
      "bash", ["-lc", "sleep 0.3; echo done"],
      cliTestCwd,
      { timeoutMs: 0, idleTimeoutMs: 0, killGraceMs: 25 },
    );
    expect(result.text).toContain("done");
  }, 5000);
});
