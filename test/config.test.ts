import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { loadBotsConfig, validateTokenUniqueness, resolveExecutionMode, resolveBusyMessageMode, validateBusyMessageModeEnv } from "../src/config.js";

describe("loadBotsConfig", () => {
  it("documents ACP model/effort env as optional preference policy, not capability truth", () => {
    const claudeExample = readFileSync(new URL("../.env.claude.example", import.meta.url), "utf8");
    expect(claudeExample).toContain("# CLAUDE_MODEL_PREFERENCE=sonnet,opus,haiku");
    expect(claudeExample).toContain("opaque model options advertised by");
    expect(claudeExample).toContain("# CLAUDE_EFFORT=medium");

    const codexExample = readFileSync(new URL("../.env.codex.example", import.meta.url), "utf8");
    expect(codexExample).toContain("# CODEX_MODEL_PREFERENCE=<opaque-model-value>,<opaque-model-value>");
    expect(codexExample).toContain("# CODEX_EFFORT=medium");
  });

  it("builds all supported bot configs with defaults from an empty env", () => {
    const bots = loadBotsConfig({});
    expect(Object.keys(bots).sort()).toEqual(["antigravity", "claude", "codex", "cursor", "grok"]);
    expect(bots.codex.command).toContain("node_modules/.bin/codex-acp");
    expect(bots.claude.command).toContain("node_modules/.bin/claude-agent-acp");
    expect(bots.codex.modelPreference).toEqual([]);
    expect(bots.claude.modelPreference).toEqual([]);
    expect(bots.antigravity.command).toBe("agy");
    expect(bots.grok.command).toBe("grok");
    expect(bots.cursor.command).toBe("cursor-agent");
  });

  it("keeps ACP preference env out of the legacy static model catalogue", () => {
    const bots = loadBotsConfig({
      CODEX_ACP_COMMAND: "/opt/bin/codex-acp",
      CLAUDE_ACP_COMMAND: "/opt/bin/claude-agent-acp",
      CODEX_MODEL_PREFERENCE: "opaque-a,opaque-b",
      CLAUDE_MODEL_PREFERENCE: "sonnet,opus",
      ANTIGRAVITY_MODEL_PREFERENCE: "m1, m2 ,m3",
    });
    expect(bots.codex.command).toBe("/opt/bin/codex-acp");
    expect(bots.claude.command).toBe("/opt/bin/claude-agent-acp");
    expect(bots.codex.modelPreference).toEqual([]);
    expect(bots.claude.modelPreference).toEqual([]);
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
    expect(resolveExecutionMode("grok", {})).toBe("safe");
    expect(resolveExecutionMode("cursor", {})).toBe("safe");
  });

  it("lets per-bot env vars override the global mode", () => {
    expect(resolveExecutionMode("codex", { CODEX_EXECUTION_MODE: "trusted", BRIDGE_EXECUTION_MODE: "safe" })).toBe("trusted");
    expect(resolveExecutionMode("grok", { GROK_EXECUTION_MODE: "safe", BRIDGE_EXECUTION_MODE: "trusted" })).toBe("safe");
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
