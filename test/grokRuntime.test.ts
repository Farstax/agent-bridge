import { describe, expect, it } from "vitest";
import { getProviderAdapter, PROVIDER_IDS, resolveProviderExecutable } from "../src/providers/registry.js";
import { interactiveChainKinds, parseCliChain } from "../src/providers/selection.js";
import { classifyProviderError } from "../src/providers/errorClassification.js";
import { loadBotsConfig } from "../src/config.js";
import { openDb } from "../src/db.js";

describe("grok provider registration", () => {
  it("registers grok as an interactive fallback provider", () => {
    expect(PROVIDER_IDS).toContain("grok");
    const adapter = getProviderAdapter("grok");
    expect(adapter.displayName).toBe("Grok Build");
    expect(adapter.executable).toBeUndefined();
    expect(adapter.capabilities.interactive).toBe(true);
    expect(adapter.capabilities.fallbackTarget).toBe(true);
    expect(adapter.capabilities.toolFree).toBeUndefined();
  });

  it("resolves the bundled Grok ACP executable instead of a native headless command", () => {
    expect(resolveProviderExecutable("grok", { BRIDGE_CURRENT_RELEASE_DIR: "/opt/agent-bridge" }))
      .toBe("grok");
    expect(resolveProviderExecutable("grok", { GROK_ACP_COMMAND: "/opt/xai/bin/grok" }))
      .toBe("/opt/xai/bin/grok");
    expect(loadBotsConfig({ BRIDGE_CURRENT_RELEASE_DIR: "/opt/agent-bridge" }).grok.command)
      .toBe("grok");
    expect(loadBotsConfig({ GROK_ACP_COMMAND: "/usr/local/bin/grok" }).grok.command)
      .toBe("/usr/local/bin/grok");
  });

  it("supports the production default fallback with Antigravity ahead of Grok", () => {
    const fallback = ["codex", "claude", "antigravity", "grok", "cursor"] as const;
    expect(parseCliChain(undefined, {
      allowed: interactiveChainKinds(),
      fallback,
    })).toEqual(["codex", "claude", "antigravity", "grok", "cursor"]);
    expect(interactiveChainKinds()).toContain("grok");
  });

  it("still honors explicit INTERACTIVE_CLI_CHAIN overrides", () => {
    const defaultChain = ["codex", "claude", "antigravity", "grok", "cursor"] as const;
    expect(parseCliChain("grok", {
      allowed: interactiveChainKinds(),
      fallback: defaultChain,
    })).toEqual(["grok"]);
    expect(parseCliChain("codex,grok", {
      allowed: interactiveChainKinds(),
      fallback: defaultChain,
    })).toEqual(["codex", "grok"]);
  });
});

describe("grok error classification", () => {
  it("classifies missing authentication without treating it as fallback capacity", () => {
    expect(classifyProviderError("grok", new Error("authentication required: grok login"))).toMatchObject({
      kind: "auth_required",
    });
    expect(classifyProviderError("grok", new Error("XAI_API_KEY is missing"))).toMatchObject({
      kind: "auth_required",
    });
  });
});

describe("grok session persistence", () => {
  it("stores and resumes a Grok session id independently of Claude", () => {
    const db = openDb(":memory:");
    expect(db.getSession("chat:1", "grok")).toBeNull();
    db.setSession("chat:1", "grok", "sess-live");
    expect(db.getSession("chat:1", "grok")).toBe("sess-live");
    expect(db.getSession("chat:1", "claude")).toBeNull();
  });
});
