import { describe, expect, it } from "vitest";
import { loadBotsConfig } from "../src/config.js";

describe("Execution path contracts", () => {
  it("ignores retired dedicated Telegram aliases but keeps Antigravity ACP command resolution", () => {
    const config = loadBotsConfig({
      TELEGRAM_BOT_TOKEN_GEMINI: "legacy-token",
      GEMINI_COMMAND: "legacy-agy",
      GEMINI_MODEL_PREFERENCE: "model-a,model-b",
      GEMINI_PROJECT_DIR: "/srv/project",
    });

    expect(config.antigravity).toMatchObject({
      token: undefined,
      command: "/usr/local/bin/agy",
      modelPreference: [],
    });
  });
});

describe("Idle Timeout Config", () => {
  it("buildExecutionOptions returns the default recoverable idle threshold with hard timeout disabled", async () => {
    const { buildExecutionOptions } = await import("../src/cli.js");
    const savedAntigravityIdle = process.env.ANTIGRAVITY_CLI_IDLE_TIMEOUT_MS;
    const savedGlobalIdle = process.env.CLI_IDLE_TIMEOUT_MS;
    const savedAntigravityHard = process.env.ANTIGRAVITY_CLI_TIMEOUT_MS;
    const savedGlobalHard = process.env.CLI_TIMEOUT_MS;
    delete process.env.ANTIGRAVITY_CLI_IDLE_TIMEOUT_MS;
    delete process.env.CLI_IDLE_TIMEOUT_MS;
    delete process.env.ANTIGRAVITY_CLI_TIMEOUT_MS;
    delete process.env.CLI_TIMEOUT_MS;
    try {
      const opts = buildExecutionOptions("antigravity");
      expect(opts.idleTimeoutMs).toBe(15 * 60_000);
      expect(opts.timeoutMs).toBe(0);
    } finally {
      if (savedAntigravityIdle !== undefined) process.env.ANTIGRAVITY_CLI_IDLE_TIMEOUT_MS = savedAntigravityIdle;
      if (savedGlobalIdle !== undefined) process.env.CLI_IDLE_TIMEOUT_MS = savedGlobalIdle;
      if (savedAntigravityHard !== undefined) process.env.ANTIGRAVITY_CLI_TIMEOUT_MS = savedAntigravityHard;
      if (savedGlobalHard !== undefined) process.env.CLI_TIMEOUT_MS = savedGlobalHard;
    }
  });

});
