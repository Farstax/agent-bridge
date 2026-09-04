import { afterEach, describe, expect, it } from "vitest";
import { buildCliInvocation, buildExecutionOptions } from "../src/cli.js";
import { applyAntigravityPrintTimeoutPolicy } from "../src/providers/antigravitySerializedRunner.js";

const timeoutKeys = [
  "ANTIGRAVITY_CLI_TIMEOUT_MS",
  "CLI_TIMEOUT_MS",
  "ANTIGRAVITY_DISABLED_PRINT_TIMEOUT_MS",
] as const;
const saved = new Map<string, string | undefined>();

function saveAndSetTimeouts(values: Partial<Record<(typeof timeoutKeys)[number], string | undefined>>): void {
  for (const key of timeoutKeys) {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function finalPrintTimeoutArg(): string | null {
  const invocation = buildCliInvocation({
    bot: "antigravity",
    command: "agy",
    prompt: "answer briefly",
    sessionId: null,
  });
  const executionOptions = buildExecutionOptions("antigravity");
  const args = applyAntigravityPrintTimeoutPolicy(invocation.args, executionOptions.timeoutMs ?? 0);
  const index = args.indexOf("--print-timeout");
  return index === -1 ? null : args[index + 1] ?? null;
}

afterEach(() => {
  for (const key of timeoutKeys) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
});

describe("Antigravity timeout contract", () => {
  it("overrides Agy's native five-minute default at the spawn boundary when Bridge hard timeout is disabled", () => {
    saveAndSetTimeouts({});

    const providerTimeout = finalPrintTimeoutArg();

    expect(providerTimeout).toBe("876000h");
    expect(providerTimeout).not.toBe("5m");
    expect(providerTimeout).not.toBe("0s");
    expect(buildExecutionOptions("antigravity").timeoutMs).toBe(0);
  });

  it("treats an explicit per-provider zero as disabled even when the global timeout is positive", () => {
    saveAndSetTimeouts({
      ANTIGRAVITY_CLI_TIMEOUT_MS: "0",
      CLI_TIMEOUT_MS: "600000",
    });

    expect(finalPrintTimeoutArg()).toBe("876000h");
    expect(buildExecutionOptions("antigravity").timeoutMs).toBe(0);
  });

  it("maps an explicit positive Antigravity hard timeout to Agy print mode", () => {
    saveAndSetTimeouts({
      ANTIGRAVITY_CLI_TIMEOUT_MS: "600000",
      CLI_TIMEOUT_MS: "1200000",
    });

    expect(finalPrintTimeoutArg()).toBe("600s");
    expect(buildExecutionOptions("antigravity").timeoutMs).toBe(600000);
  });

  it("allows the provider compatibility ceiling to be configured without enabling the Bridge hard timeout", () => {
    saveAndSetTimeouts({
      ANTIGRAVITY_CLI_TIMEOUT_MS: "0",
      ANTIGRAVITY_DISABLED_PRINT_TIMEOUT_MS: "900000",
    });

    expect(finalPrintTimeoutArg()).toBe("900s");
    expect(buildExecutionOptions("antigravity").timeoutMs).toBe(0);
  });

  it("rejects an invalid provider compatibility ceiling instead of falling back silently", () => {
    saveAndSetTimeouts({
      ANTIGRAVITY_CLI_TIMEOUT_MS: "0",
      ANTIGRAVITY_DISABLED_PRINT_TIMEOUT_MS: "0",
    });

    expect(() => finalPrintTimeoutArg()).toThrow(/ANTIGRAVITY_DISABLED_PRINT_TIMEOUT_MS must be a positive number/);
  });
});
