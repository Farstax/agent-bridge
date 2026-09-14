import { afterEach, describe, expect, it } from "vitest";
import { buildCliInvocation, buildExecutionOptions } from "../src/cli.js";

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

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
});

describe("Agy ACP timeout contract", () => {
  it("does not inject a native --print-timeout flag", () => {
    saveAndSetTimeouts({ ANTIGRAVITY_CLI_TIMEOUT_MS: "1500" });
    const invocation = buildCliInvocation({
      bot: "antigravity",
      command: "agy_acp_server.par",
      prompt: "answer briefly",
      sessionId: null,
    });
    expect(invocation.transport).toBe("acp-stdio");
    expect(invocation.args).not.toContain("--print-timeout");
    expect(invocation.args).not.toContain("--print");
    expect(buildExecutionOptions("antigravity").timeoutMs).toBe(1500);
  });

  it("keeps Bridge supervisor timeout disabled by default", () => {
    saveAndSetTimeouts({ ANTIGRAVITY_CLI_TIMEOUT_MS: undefined, CLI_TIMEOUT_MS: undefined });
    expect(buildExecutionOptions("antigravity").timeoutMs).toBe(0);
  });
});
