import { afterEach, describe, expect, it } from "vitest";
import { assertQualificationRuntimeEnvironment } from "../src/providers/qualification.js";

const savedApiKey = process.env.ANTHROPIC_API_KEY;
const savedAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
const savedBackgroundFence = process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS;
const savedReleaseDir = process.env.BRIDGE_CURRENT_RELEASE_DIR;

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  restore("ANTHROPIC_API_KEY", savedApiKey);
  restore("ANTHROPIC_AUTH_TOKEN", savedAuthToken);
  restore("CLAUDE_CONFIG_DIR", savedConfigDir);
  restore("CLAUDE_CODE_DISABLE_BACKGROUND_TASKS", savedBackgroundFence);
  restore("BRIDGE_CURRENT_RELEASE_DIR", savedReleaseDir);
});

describe("Claude ACP qualification environment", () => {
  it("fails closed when qualification credential/config state differs from the active runtime", () => {
    process.env.ANTHROPIC_API_KEY = "active-key";
    process.env.CLAUDE_CONFIG_DIR = "/runtime/.claude";

    expect(() => assertQualificationRuntimeEnvironment("claude", {
      ...process.env,
      ANTHROPIC_API_KEY: "candidate-key",
      CLAUDE_CONFIG_DIR: "/candidate/.claude",
    })).toThrow(/claude qualification runtime environment mismatch.*ANTHROPIC_API_KEY.*CLAUDE_CONFIG_DIR/i);
  });

  it("accepts equal active and qualification environments", () => {
    process.env.ANTHROPIC_API_KEY = "active-key";
    process.env.CLAUDE_CONFIG_DIR = "/runtime/.claude";
    const active = { ...process.env };
    expect(() => assertQualificationRuntimeEnvironment("claude", { ...active }, active)).not.toThrow();
  });
});
