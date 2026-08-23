import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { loadBotsConfig, validateTokenUniqueness, resolveExecutionMode, resolveBusyMessageMode, validateBusyMessageModeEnv } from "../src/config.js";

describe("loadBotsConfig", () => {
  it("documents the current Claude model fallback chain in the example environment", () => {
    const example = readFileSync(new URL("../.env.claude.example", import.meta.url), "utf8");
    expect(example).toContain(
      "CLAUDE_MODEL_PREFERENCE=claude-sonnet-5,claude-opus-5,claude-opus-4-8,claude-haiku-4-5,claude-fable-5",
    );
  });

  it("builds all supported bot configs with defaults from an empty env", () => {
    const bots = loadBotsConfig({});
    expect(Object.keys(bots).sort()).toEqual(["antigravity", "claude", "codex", "grok"]);
    expect(bots.codex.command).toBe("codex");
    expect(bots.claude.command).toBe("claude");
    expect(bots.antigravity.command).toBe("agy");
    expect(bots.grok.command).toBe("grok");
  });

  it("respects env overrides for commands and model preferences", () => {
    const bots = loadBotsConfig({
      CODEX_COMMAND: "/opt/bin/codex",
      REMOVED_PROVIDER_MODEL_PREFERENCE: "a,b",
      ANTIGRAVITY_MODEL_PREFERENCE: "m1, m2 ,m3",
    });
    expect(bots.codex.command).toBe("/opt/bin/codex");
    expect(bots.antigravity.modelPreference).toEqual(["m1", "m2", "m3"]);
  });

  it("honours legacy GEMINI_* fallbacks for antigravity", () => {
    const bots = loadBotsConfig({ GEMINI_COMMAND: "gem", TELEGRAM_BOT_TOKEN_GEMINI: "t1" }, { withTokens: true });
    expect(bots.antigravity.command).toBe("gem");
    expect(bots.antigravity.token).toBe("t1");
  });

  it("omits tokens unless withTokens is set", () => {
    const env = { TELEGRAM_BOT_TOKEN_CODEX: "tok" };
    expect(loadBotsConfig(env).codex.token).toBeUndefined();
    expect(loadBotsConfig(env, { withTokens: true }).codex.token).toBe("tok");
  });
});

describe("validateTokenUniqueness", () => {
  it("passes when all defined tokens are distinct", () => {
    expect(() => validateTokenUniqueness({ codex: "a", claude: "b", antigravity: undefined })).not.toThrow();
  });

  it("throws naming both surfaces when two share a token", () => {
    expect(() => validateTokenUniqueness({ codex: "same", claude: "same" }))
      .toThrow(/codex.*claude|claude.*codex/);
  });

  it("ignores undefined and empty tokens", () => {
    expect(() => validateTokenUniqueness({ a: undefined, b: "", c: "x" })).not.toThrow();
  });
});

describe("resolveExecutionMode", () => {
  it("defaults supported providers to safe", () => {
    expect(resolveExecutionMode("codex", {})).toBe("safe");
    expect(resolveExecutionMode("claude", {})).toBe("safe");
    expect(resolveExecutionMode("antigravity", {})).toBe("safe");
  });

  it("lets per-bot env vars override the global mode", () => {
    expect(resolveExecutionMode("codex", { CODEX_EXECUTION_MODE: "trusted", BRIDGE_EXECUTION_MODE: "safe" })).toBe("trusted");
  });

  it("falls back to BRIDGE_EXECUTION_MODE when no per-bot var is set", () => {
    expect(resolveExecutionMode("codex", { BRIDGE_EXECUTION_MODE: "trusted" })).toBe("trusted");
  });
});

describe("resolveBusyMessageMode", () => {
  it("defaults to augment when unset", () => {
    expect(resolveBusyMessageMode({})).toBe("augment");
  });

  it("honours an explicit queue setting", () => {
    expect(resolveBusyMessageMode({ BRIDGE_BUSY_MESSAGE_MODE: "queue" })).toBe("queue");
  });

  it("honours an explicit interrupt setting", () => {
    expect(resolveBusyMessageMode({ BRIDGE_BUSY_MESSAGE_MODE: "interrupt" })).toBe("interrupt");
  });

});

describe("validateBusyMessageModeEnv", () => {
  it("accepts an unset value", () => {
    expect(() => validateBusyMessageModeEnv({})).not.toThrow();
  });

  it("accepts augment, interrupt and queue", () => {
    expect(() => validateBusyMessageModeEnv({ BRIDGE_BUSY_MESSAGE_MODE: "augment" })).not.toThrow();
    expect(() => validateBusyMessageModeEnv({ BRIDGE_BUSY_MESSAGE_MODE: "interrupt" })).not.toThrow();
    expect(() => validateBusyMessageModeEnv({ BRIDGE_BUSY_MESSAGE_MODE: "queue" })).not.toThrow();
  });

  it("throws on an invalid value", () => {
    expect(() => validateBusyMessageModeEnv({ BRIDGE_BUSY_MESSAGE_MODE: "replace" })).toThrow(/BRIDGE_BUSY_MESSAGE_MODE/);
  });
});

describe("architectural intent: entry points use the shared config module", () => {
  const entryPoints = [
    "src/index-interactive.ts",
    "src/index-discord-interactive.ts",
  ];

  it.each(entryPoints)("%s imports loadBotsConfig and has no inline bots literal", (file) => {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    expect(source).toMatch(/from ["']\.\/config\.js["']/);
    // No entry point may build a bot config inline any more.
    expect(source).not.toMatch(/modelPreference:\s*parseModelPreference\(/);
    expect(source).not.toMatch(/REMOVED_PROVIDER_MODEL_PREFERENCE\s*\|\|/);
  });
});
