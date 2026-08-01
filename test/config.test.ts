import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { loadBotsConfig, validateTokenUniqueness, resolveExecutionMode, resolveBusyMessageMode, validateBusyMessageModeEnv } from "../src/config.js";

describe("loadBotsConfig", () => {
  it("documents Claude's stable model aliases in the example environment", () => {
    const example = readFileSync(new URL("../.env.claude.example", import.meta.url), "utf8");
    expect(example).toContain("CLAUDE_MODEL_PREFERENCE=sonnet,opus,haiku,fable");
  });

  it("builds all four bot configs with defaults from an empty env", () => {
    const bots = loadBotsConfig({});
    expect(Object.keys(bots).sort()).toEqual(["antigravity", "claude", "codex", "kimchi"]);
    expect(bots.codex.command).toBe("codex");
    expect(bots.claude.command).toBe("claude");
    expect(bots.antigravity.command).toBe("agy");
    expect(bots.kimchi.command).toContain("kimchi");
    expect(bots.kimchi.modelPreference[0]).toBe("kimi-k2.7");
  });

  it("respects env overrides for commands and model preferences", () => {
    const bots = loadBotsConfig({
      CODEX_COMMAND: "/opt/bin/codex",
      KIMCHI_MODEL_PREFERENCE: "a,b",
      ANTIGRAVITY_MODEL_PREFERENCE: "m1, m2 ,m3",
    });
    expect(bots.codex.command).toBe("/opt/bin/codex");
    expect(bots.kimchi.modelPreference).toEqual(["a", "b"]);
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
    expect(() => validateTokenUniqueness({ codex: "same", worker: "same" }))
      .toThrow(/codex.*worker|worker.*codex/);
  });

  it("ignores undefined and empty tokens", () => {
    expect(() => validateTokenUniqueness({ a: undefined, b: "", c: "x" })).not.toThrow();
  });
});

describe("resolveExecutionMode", () => {
  it("defaults Kimchi to trusted and others to safe", () => {
    expect(resolveExecutionMode("kimchi", {})).toBe("trusted");
    expect(resolveExecutionMode("codex", {})).toBe("safe");
    expect(resolveExecutionMode("claude", {})).toBe("safe");
    expect(resolveExecutionMode("antigravity", {})).toBe("safe");
  });

  it("lets per-bot env vars override the global mode", () => {
    expect(resolveExecutionMode("kimchi", { KIMCHI_EXECUTION_MODE: "safe" })).toBe("safe");
    expect(resolveExecutionMode("codex", { CODEX_EXECUTION_MODE: "trusted", BRIDGE_EXECUTION_MODE: "safe" })).toBe("trusted");
  });

  it("falls back to BRIDGE_EXECUTION_MODE when no per-bot var is set", () => {
    expect(resolveExecutionMode("kimchi", { BRIDGE_EXECUTION_MODE: "safe" })).toBe("safe");
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

  it("has no per-CLI override — only the flat BRIDGE_BUSY_MESSAGE_MODE var is read", () => {
    const src = readFileSync(new URL("../src/config.ts", import.meta.url), "utf8");
    const fnStart = src.indexOf("export function resolveBusyMessageMode");
    const fn = src.slice(fnStart, src.indexOf("\n}", fnStart));
    expect(fn).not.toMatch(/\$\{.*\}_BUSY_MESSAGE_MODE/); // no per-kind prefix template
    expect(fn).not.toMatch(/toUpperCase/);
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
    "src/index.ts",
    "src/index-interactive.ts",
    "src/index-worker.ts",
    "src/index-discord-interactive.ts",
  ];

  it.each(entryPoints)("%s imports loadBotsConfig and has no inline bots literal", (file) => {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    expect(source).toMatch(/from ["']\.\/config\.js["']/);
    // No entry point may build a bot config inline any more.
    expect(source).not.toMatch(/modelPreference:\s*parseModelPreference\(/);
    expect(source).not.toMatch(/KIMCHI_MODEL_PREFERENCE\s*\|\|/);
  });
});
