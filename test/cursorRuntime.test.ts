import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBotsConfig, resolveExecutionMode } from "../src/config.js";
import { openDb } from "../src/db.js";
import { getProviderAdapter, PROVIDER_IDS, resolveProviderExecutable, supportsToolFreeMode } from "../src/providers/registry.js";
import { interactiveChainKinds, parseCliChain } from "../src/providers/selection.js";
import { resolveSkillPaths, CURSOR_SKILL_DISCOVERY_NOTE } from "../src/skills.js";

describe("cursor provider registration", () => {
  it("registers cursor as an interactive fallback provider", () => {
    expect(PROVIDER_IDS).toContain("cursor");
    const adapter = getProviderAdapter("cursor");
    expect(adapter.displayName).toBe("Cursor");
    expect(adapter.executable).toBeUndefined();
    expect(adapter.capabilities.interactive).toBe(true);
    expect(adapter.capabilities.fallbackTarget).toBe(true);
    expect(adapter.capabilities.toolFree).toBeUndefined();
    expect(supportsToolFreeMode("cursor")).toBe(false);
  });

  it("resolves the Cursor ACP executable instead of a native headless command", () => {
    expect(resolveProviderExecutable("cursor", {})).toBe("cursor-agent");
    expect(resolveProviderExecutable("cursor", { CURSOR_ACP_COMMAND: "/opt/cursor/cursor-agent" }))
      .toBe("/opt/cursor/cursor-agent");
    expect(loadBotsConfig({}).cursor.command).toBe("cursor-agent");
    expect(loadBotsConfig({ CURSOR_ACP_COMMAND: "/usr/local/bin/cursor-agent" }).cursor.command)
      .toBe("/usr/local/bin/cursor-agent");
    expect(loadBotsConfig({ CURSOR_MODEL_PREFERENCE: "composer-2.5,auto" }).cursor.modelPreference).toEqual([]);
  });

  it("participates in the production default interactive fallback as the final target", () => {
    expect(interactiveChainKinds()).toContain("cursor");
    const productionDefault = ["codex", "claude", "antigravity", "grok", "cursor"] as const;
    expect(productionDefault).toContain("cursor");
    expect(productionDefault.at(-1)).toBe("cursor");
    expect(parseCliChain(undefined, {
      allowed: interactiveChainKinds(),
      fallback: productionDefault,
    })).toEqual(["codex", "claude", "antigravity", "grok", "cursor"]);
  });

  it("still honors explicit INTERACTIVE_CLI_CHAIN overrides", () => {
    const defaultChain = ["codex", "claude", "antigravity", "grok", "cursor"] as const;
    expect(parseCliChain("cursor", {
      allowed: interactiveChainKinds(),
      fallback: defaultChain,
    })).toEqual(["cursor"]);
    expect(parseCliChain("codex,cursor", {
      allowed: interactiveChainKinds(),
      fallback: defaultChain,
    })).toEqual(["codex", "cursor"]);
    expect(parseCliChain("claude,antigravity", {
      allowed: interactiveChainKinds(),
      fallback: defaultChain,
    })).toEqual(["claude", "antigravity"]);
  });

  it("uses shared safe|trusted execution-mode resolution", () => {
    expect(resolveExecutionMode("cursor", {})).toBe("safe");
    expect(resolveExecutionMode("cursor", { CURSOR_EXECUTION_MODE: "trusted" })).toBe("trusted");
    expect(resolveExecutionMode("cursor", { CURSOR_EXECUTION_MODE: "safe", BRIDGE_EXECUTION_MODE: "trusted" })).toBe("safe");
  });
});

describe("cursor skill projection", () => {
  it("uses one canonical Cursor-native skill directory and documents no auto multi-provider projection", () => {
    const home = mkdtempSync(join(tmpdir(), "cursor-skills-"));
    const paths = resolveSkillPaths(home);
    expect(paths.cursorSkillsDir).toBe(join(home, ".cursor", "skills"));
    expect(CURSOR_SKILL_DISCOVERY_NOTE).toMatch(/does not auto-project/i);
    expect(CURSOR_SKILL_DISCOVERY_NOTE).toMatch(/\.cursor\/skills/i);
  });
});

describe("cursor session persistence", () => {
  it("stores and reloads Cursor session ids through the shared session repository", () => {
    const db = openDb(":memory:");
    expect(db.getSession("chat:cursor", "cursor")).toBeNull();
    db.setSession("chat:cursor", "cursor", "sess-durable");
    expect(db.getSession("chat:cursor", "cursor")).toBe("sess-durable");
    db.setSession("chat:cursor", "cursor", null);
    expect(db.getSession("chat:cursor", "cursor")).toBeNull();
  });

  it("includes Cursor consecutive failures in the health circuit-breaker aggregate", () => {
    const db = openDb(":memory:");
    db.incrementFailures("chat:cursor", "cursor");
    db.incrementFailures("chat:cursor", "cursor");
    expect(db.getMaxConsecutiveFailures()).toEqual([{ bot: "cursor", count: 2 }]);
    db.resetFailures("chat:cursor", "cursor");
    expect(db.getMaxConsecutiveFailures()).toEqual([]);
  });
});
