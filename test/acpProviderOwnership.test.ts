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
    expect(source).not.toMatch(/bot\s*===\s*["'](?:codex|claude)["']/);
  });

  it("keeps shared ACP session planning free of migrated-provider branches", () => {
    const source = readFileSync("src/acp/sessionConfig.ts", "utf8");
    expect(source).not.toMatch(/providerId\s*===\s*["'](?:codex|claude)["']/);
    expect(source).not.toMatch(/providerId\s*!==\s*["'](?:codex|claude)["']/);
  });

  it("dispatches ACP API-key verification through registered provider policy", () => {
    const source = readFileSync("src/providers/apiKeyAuth.ts", "utf8");
    const start = source.indexOf("export async function verifyProviderApiKey");
    const end = source.indexOf("export async function verifyConfiguredProviderApiKeys");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const verification = source.slice(start, end);
    expect(verification).toContain("getAcpProviderApiKeyProbe(provider)");
    expect(verification).not.toMatch(/\b(?:codex|claude)\b/);
    expect(source).not.toMatch(/(?:codex|claude)AcpProbe/);
    expect(source).not.toContain("CodexAcpApiKeyProbeExecutor");
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

  it("preserves native owners that have not completed ACP migration", () => {
    expect(existsSync("src/providers/antigravityRuntime.ts")).toBe(true);
    expect(existsSync("src/providers/grokRuntime.ts")).toBe(true);
    expect(existsSync("src/providers/cursorRuntime.ts")).toBe(true);
  });
});
