import { afterEach, describe, expect, it } from "vitest";
import { buildCliInvocation } from "../src/cli.js";

const timeoutKeys = ["ANTIGRAVITY_CLI_TIMEOUT_MS", "CLI_TIMEOUT_MS"] as const;
const saved = new Map<string, string | undefined>();

function saveAndSetTimeouts(values: Partial<Record<(typeof timeoutKeys)[number], string | undefined>>): void {
  for (const key of timeoutKeys) {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function printTimeoutArg(): string | null {
  const invocation = buildCliInvocation({
    bot: "antigravity",
    command: "agy",
    prompt: "answer briefly",
    sessionId: null,
  });
  const index = invocation.args.indexOf("--print-timeout");
  return index === -1 ? null : invocation.args[index + 1] ?? null;
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
  it("overrides Agy's native five-minute default when Bridge hard timeout is disabled", () => {
    saveAndSetTimeouts({});

    const providerTimeout = printTimeoutArg();

    expect(providerTimeout).toBe("876000h");
    expect(providerTimeout).not.toBe("5m");
    expect(providerTimeout).not.toBe("0s");
  });

  it("treats an explicit per-provider zero as disabled even when the global timeout is positive", () => {
    saveAndSetTimeouts({
      ANTIGRAVITY_CLI_TIMEOUT_MS: "0",
      CLI_TIMEOUT_MS: "600000",
    });

    expect(printTimeoutArg()).toBe("876000h");
  });

  it("maps an explicit positive Antigravity hard timeout to Agy print mode", () => {
    saveAndSetTimeouts({
      ANTIGRAVITY_CLI_TIMEOUT_MS: "600000",
      CLI_TIMEOUT_MS: "1200000",
    });

    expect(printTimeoutArg()).toBe("600s");
  });
});
