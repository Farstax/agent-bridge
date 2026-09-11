import { describe, it, expect } from "vitest";
import {
  acpProviderIdForBotName,
  supportsProvisionalAnswers,
} from "../src/providers/acpRuntime.js";
import {
  getProviderAdapter,
  getProviderAdapters,
  isProviderId,
  assertProviderId,
  PROVIDER_IDS,
  supportsToolFreeMode,
  resolveProviderExecutable,
} from "../src/providers/registry.js";
import type { ProviderId } from "../src/providers/types.js";

describe("provider registry", () => {
  it("exports the canonical provider ids", () => {
    expect(PROVIDER_IDS).toEqual(["codex", "claude", "agy", "grok", "cursor"]);
  });

  it("returns all adapters in stable order", () => {
    const adapters = getProviderAdapters();
    expect(adapters.map((a) => a.id)).toEqual(["codex", "claude", "agy", "grok", "cursor"]);
  });

  it("returns the codex adapter", () => {
    const adapter = getProviderAdapter("codex");
    expect(adapter.id).toBe("codex");
    expect(adapter.displayName).toBe("Codex");
    expect(adapter.executable).toBe("codex-acp");
    expect(adapter.defaultArgs).toEqual([]);
    expect(adapter.capabilities.interactive).toBe(true);
    expect(adapter.capabilities.toolFree).toBe(false);
  });

  it("returns the claude adapter", () => {
    const adapter = getProviderAdapter("claude");
    expect(adapter.id).toBe("claude");
    expect(adapter.displayName).toBe("Claude Code");
    expect(adapter.executable).toBe("claude");
  });

  it("returns the agy adapter", () => {
    const adapter = getProviderAdapter("agy");
    expect(adapter.id).toBe("agy");
    expect(adapter.displayName).toBe("Antigravity");
    expect(adapter.executable).toBe("agy");
  });

  it("validates known provider ids", () => {
    expect(isProviderId("codex")).toBe(true);
    expect(isProviderId("claude")).toBe(true);
    expect(isProviderId("agy")).toBe(true);
    expect(isProviderId("grok")).toBe(true);
    expect(isProviderId("cursor")).toBe(true);
    expect(isProviderId("not-a-provider")).toBe(false);
    expect(isProviderId("")).toBe(false);
  });

  it("asserts known provider ids", () => {
    expect(assertProviderId("codex")).toBe("codex");
    expect(assertProviderId("agy")).toBe("agy");
  });

  it("throws for unknown provider ids", () => {
    expect(() => assertProviderId("not-a-provider")).toThrow("Unknown provider id");
    expect(() => assertProviderId("")).toThrow("Unknown provider id");
  });

  it("rejects unknown provider ids when looked up directly", () => {
    expect(() => getProviderAdapter("not-a-provider" as ProviderId)).toThrow();
  });

  it("reports Codex ACP as not supporting strict tool-free execution", () => {
    expect(supportsToolFreeMode("codex")).toBe(false);
    expect(supportsToolFreeMode("claude")).toBe(true);
  });

  it("derives provisional-answer eligibility from the resolved ACP presentation policy, not a provider-name branch", () => {
    expect(supportsProvisionalAnswers("codex")).toBe(true);
    expect(supportsProvisionalAnswers("claude")).toBe(true);
    expect(supportsProvisionalAnswers("antigravity")).toBe(false);
    expect(supportsProvisionalAnswers("not-a-bot-kind")).toBe(false);
  });

  it("resolves the ACP-backed provider id behind a bot kind generically for session-binding routing", () => {
    expect(acpProviderIdForBotName("codex")).toBe("codex");
    expect(acpProviderIdForBotName("claude")).toBe("claude");
    expect(acpProviderIdForBotName("antigravity")).toBeNull();
    expect(acpProviderIdForBotName("not-a-bot-kind")).toBeNull();
  });

  it("resolves the bundled or explicitly configured Codex ACP command", () => {
    expect(resolveProviderExecutable("codex", { BRIDGE_CURRENT_RELEASE_DIR: "/opt/agent-bridge" }))
      .toBe("/opt/agent-bridge/node_modules/.bin/codex-acp");
    expect(resolveProviderExecutable("codex", { CODEX_ACP_COMMAND: "/trusted/codex-acp" }))
      .toBe("/trusted/codex-acp");
  });

  it("resolves the bundled or explicitly configured Claude ACP command", () => {
    expect(resolveProviderExecutable("claude", { BRIDGE_CURRENT_RELEASE_DIR: "/opt/agent-bridge" }))
      .toBe("/opt/agent-bridge/node_modules/.bin/claude-agent-acp");
    expect(resolveProviderExecutable("claude", { CLAUDE_ACP_COMMAND: "/trusted/claude-agent-acp" }))
      .toBe("/trusted/claude-agent-acp");
  });

  it("exposes fallback metadata", () => {
    const codex = getProviderAdapter("codex");
    expect(typeof codex.capabilities.fallbackTarget).toBe("boolean");
    expect(getProviderAdapter("grok").capabilities.fallbackTarget).toBe(true);
  });
});
