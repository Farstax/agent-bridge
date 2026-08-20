import { describe, expect, it } from "vitest";
import { loadBotsConfig } from "../src/config.js";

describe("Execution path contracts", () => {
  it("loads deprecated Gemini environment aliases into the Antigravity runtime config", () => {
    const config = loadBotsConfig({
      TELEGRAM_BOT_TOKEN_GEMINI: "legacy-token",
      GEMINI_COMMAND: "legacy-agy",
      GEMINI_MODEL_PREFERENCE: "model-a,model-b",
      GEMINI_PROJECT_DIR: "/srv/project",
    } as any, { withTokens: true });

    expect(config.antigravity).toMatchObject({
      token: "legacy-token",
      command: "legacy-agy",
      modelPreference: ["model-a", "model-b"],
    });
  });
});

describe("Idle Timeout Config", () => {
  it("buildExecutionOptions returns per-kind timeouts (antigravity idle/hard disabled by default)", async () => {
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
      expect(opts.idleTimeoutMs).toBe(0);
      expect(opts.timeoutMs).toBe(0);
    } finally {
      if (savedAntigravityIdle !== undefined) process.env.ANTIGRAVITY_CLI_IDLE_TIMEOUT_MS = savedAntigravityIdle;
      if (savedGlobalIdle !== undefined) process.env.CLI_IDLE_TIMEOUT_MS = savedGlobalIdle;
      if (savedAntigravityHard !== undefined) process.env.ANTIGRAVITY_CLI_TIMEOUT_MS = savedAntigravityHard;
      if (savedGlobalHard !== undefined) process.env.CLI_TIMEOUT_MS = savedGlobalHard;
    }
  });

});
