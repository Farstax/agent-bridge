import { describe, it, expect } from "vitest";
import {
  getProviderAdapter,
  getProviderAdapters,
  isProviderId,
  assertProviderId,
  PROVIDER_IDS,
} from "../src/providers/registry.js";
import type { ProviderId } from "../src/providers/types.js";

describe("provider registry", () => {
  it("exports the canonical provider ids", () => {
    expect(PROVIDER_IDS).toEqual(["codex", "claude", "agy", "grok"]);
  });

  it("returns all adapters in stable order", () => {
    const adapters = getProviderAdapters();
    expect(adapters.map((a) => a.id)).toEqual(["codex", "claude", "agy", "grok"]);
  });

  it("returns the codex adapter", () => {
    const adapter = getProviderAdapter("codex");
    expect(adapter.id).toBe("codex");
    expect(adapter.displayName).toBe("Codex");
    expect(adapter.executable).toBe("codex");
    expect(adapter.defaultArgs).toBeInstanceOf(Array);
    expect(adapter.capabilities.interactive).toBe(true);
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

  it("exposes fallback metadata", () => {
    const codex = getProviderAdapter("codex");
    expect(typeof codex.capabilities.fallbackTarget).toBe("boolean");
    expect(getProviderAdapter("grok").capabilities.fallbackTarget).toBe(true);
  });
});
