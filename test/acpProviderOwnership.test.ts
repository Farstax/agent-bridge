import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("migrated ACP provider ownership", () => {
  it("keeps generic ACP lifecycle and auth out of Codex compatibility modules", () => {
    expect(existsSync("src/providers/codexAcpRuntime.ts")).toBe(false);
    expect(existsSync("src/providers/codexAcpAuthProbe.ts")).toBe(false);
    expect(existsSync("src/providers/acpRuntime.ts")).toBe(true);
    expect(existsSync("src/providers/acpAuthProbe.ts")).toBe(true);
  });

  it("keeps migrated-provider compatibility dispatch out of the shared CLI", () => {
    const source = readFileSync("src/cli.ts", "utf8");
    expect(source).not.toContain("codexAcpRuntime");
    expect(source).not.toMatch(/bot\s*===\s*["'](?:codex|claude|grok|antigravity|cursor)["']/);
    expect(source).not.toContain("nativeCompletion");
    expect(source).not.toContain("void sessionMode");

    const types = readFileSync("src/providers/types.ts", "utf8");
    expect(types).not.toContain("nativeCompletion");
  });

  it("keeps shared ACP session planning free of migrated-provider branches", () => {
    const source = readFileSync("src/acp/sessionConfig.ts", "utf8");
    expect(source).not.toMatch(/providerId\s*===\s*["'](?:codex|claude|grok|agy|cursor)["']/);
    expect(source).not.toMatch(/providerId\s*!==\s*["'](?:codex|claude|grok|agy|cursor)["']/);
  });

  it("dispatches ACP API-key verification through registered provider policy", () => {
    const source = readFileSync("src/providers/apiKeyAuth.ts", "utf8");
    const start = source.indexOf("export async function verifyProviderApiKey");
    const end = source.indexOf("export async function verifyConfiguredProviderApiKeys");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const verification = source.slice(start, end);
    expect(verification).toContain("getAcpProviderPolicy(provider)?.verifyApiKey");
    expect(verification).not.toMatch(/\b(?:codex|claude|grok|agy|cursor)\b/);
    expect(source).not.toMatch(/(?:codex|claude|grok|agy|cursor)AcpProbe/);
    expect(source).not.toContain("CodexAcpApiKeyProbeExecutor");

    const registry = readFileSync("src/providers/registry.ts", "utf8");
    expect(registry).not.toContain("ACP_API_KEY_PROBES");
    expect(registry).not.toContain("getAcpProviderApiKeyProbe");
  });

  it("keeps migrated capability authority in ACP policy only", () => {
    const registry = readFileSync("src/providers/registry.ts", "utf8");
    const migratedAdapters = registry.slice(
      registry.indexOf("codex:"),
      registry.indexOf("agy:"),
    );
    expect(migratedAdapters).not.toContain("toolFree");
    const agyAdapter = registry.slice(registry.indexOf("agy:"), registry.indexOf("grok:"));
    expect(agyAdapter).not.toContain("toolFree");
    expect(agyAdapter).not.toContain("executable");
    const grokAdapter = registry.slice(registry.indexOf("grok:"), registry.indexOf("cursor:"));
    expect(grokAdapter).not.toContain("toolFree");
    expect(grokAdapter).not.toContain("executable");
    const cursorAdapter = registry.slice(registry.indexOf("cursor:"), registry.indexOf("ACP_POLICIES"));
    expect(cursorAdapter).not.toContain("toolFree");
    expect(cursorAdapter).not.toContain("executable");
  });

  it("keeps shared qualification diagnostics provider-neutral", () => {
    const source = readFileSync("src/providers/qualification.ts", "utf8");
    expect(source).toContain("providerErrorInfo=");
    expect(source).not.toContain("`codexErrorInfo=");
  });

  it("does not make Claude configuration depend on a Codex module", () => {
    const source = readFileSync("src/providers/claudeAcpConfig.ts", "utf8");
    expect(source).toContain("./acpConfig.js");
    expect(source).not.toContain("codexAcpConfig");
  });

  it("confirms every provider has completed ACP migration with no remaining native runtime", () => {
    expect(existsSync("src/providers/agyAcpRuntime.ts")).toBe(false);
    expect(existsSync("src/providers/antigravityRuntime.ts")).toBe(false);
    expect(existsSync("src/providers/grokRuntime.ts")).toBe(false);
    expect(existsSync("src/providers/cursorRuntime.ts")).toBe(false);
    expect(existsSync("src/providers/cursorAcpRuntime.ts")).toBe(false);
  });
});
