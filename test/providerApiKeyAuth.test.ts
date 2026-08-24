import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PROVIDER_API_KEY_AUTH,
  clearProviderApiKeyVerificationCache,
  getProviderApiKeyCapability,
  redactProviderApiKeySecrets,
  verifyProviderApiKey,
  withAntigravityApiKeyProvider,
} from "../src/providers/apiKeyAuth.js";
import type { ProviderId } from "../src/providers/types.js";

const providerCases: Array<{ provider: ProviderId; envVar: string; commandEnv: string }> = [
  { provider: "codex", envVar: "CODEX_API_KEY", commandEnv: "CODEX_COMMAND" },
  { provider: "claude", envVar: "ANTHROPIC_API_KEY", commandEnv: "CLAUDE_COMMAND" },
  { provider: "agy", envVar: "GEMINI_API_KEY", commandEnv: "ANTIGRAVITY_COMMAND" },
  { provider: "grok", envVar: "XAI_API_KEY", commandEnv: "GROK_COMMAND" },
  { provider: "cursor", envVar: "CURSOR_API_KEY", commandEnv: "CURSOR_COMMAND" },
];

const tempDirs: string[] = [];

afterEach(() => {
  clearProviderApiKeyVerificationCache();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("provider API-key authentication", () => {
  it("classifies every supported provider and rejects unknown providers", () => {
    expect(Object.keys(PROVIDER_API_KEY_AUTH).sort()).toEqual(["agy", "claude", "codex", "cursor", "grok"]);
    expect(getProviderApiKeyCapability("cursor")?.envVar).toBe("CURSOR_API_KEY");
    expect(getProviderApiKeyCapability("future-provider")).toBeNull();
  });

  it.each(providerCases)("requires a successful bounded native probe for $provider", ({ provider, envVar, commandEnv }) => {
    const homeDir = mkdtempSync(join(tmpdir(), `agent-bridge-${provider}-auth-test-`));
    tempDirs.push(homeDir);
    const apiKey = `secret-${provider}-572`;
    const env = {
      [envVar]: apiKey,
      [commandEnv]: `fake-${provider}`,
      TELEGRAM_BOT_TOKEN: "telegram-secret",
      ANTHROPIC_AUTH_TOKEN: "unrelated-provider-secret",
    };
    let call: { command: string; args: string[]; env: NodeJS.ProcessEnv; timeout: number } | null = null;
    const execFile = ((command: string, args: string[], options: any) => {
      call = { command, args, env: options.env, timeout: options.timeout };
      if (provider === "agy") {
        const isolatedHome = String(options.env.HOME);
        expect(isolatedHome).not.toBe(homeDir);
        const settings = JSON.parse(readFileSync(join(isolatedHome, ".gemini", "antigravity-cli", "settings.json"), "utf8"));
        expect(settings.modelProvider).toBe("gemini");
      }
      return "ok";
    }) as unknown as typeof execFileSync;

    expect(verifyProviderApiKey(provider, { env, homeDir, execFile, useCache: false })).toBe(true);
    expect(call).not.toBeNull();
    expect(call!.command).toBe(`fake-${provider}`);
    expect(call!.args.join(" ")).not.toContain(apiKey);
    expect(call!.env[envVar]).toBe(apiKey);
    expect(call!.env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    if (envVar !== "ANTHROPIC_AUTH_TOKEN") expect(call!.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(call!.timeout).toBe(15_000);
  });

  it.each(providerCases)("does not treat a non-empty $envVar as proof for $provider", ({ provider, envVar }) => {
    const env = { [envVar]: `invalid-${provider}-572` };
    const execFile = (() => {
      throw new Error("provider rejected credential");
    }) as unknown as typeof execFileSync;
    expect(verifyProviderApiKey(provider, { env, execFile, useCache: false })).toBe(false);
  });

  it("does not probe when the key is missing or blank", () => {
    let calls = 0;
    const execFile = (() => {
      calls += 1;
      return "ok";
    }) as unknown as typeof execFileSync;
    expect(verifyProviderApiKey("claude", { env: {}, execFile, useCache: false })).toBe(false);
    expect(verifyProviderApiKey("claude", { env: { ANTHROPIC_API_KEY: "   " }, execFile, useCache: false })).toBe(false);
    expect(calls).toBe(0);
  });

  it("caches successful verification briefly and then rechecks", () => {
    let calls = 0;
    const execFile = (() => {
      calls += 1;
      return "ok";
    }) as unknown as typeof execFileSync;
    const env = { CURSOR_API_KEY: "cursor-cache-key" };

    expect(verifyProviderApiKey("cursor", { env, execFile, nowMs: 0 })).toBe(true);
    expect(verifyProviderApiKey("cursor", { env, execFile, nowMs: 60_000 })).toBe(true);
    expect(calls).toBe(1);
    expect(verifyProviderApiKey("cursor", { env, execFile, nowMs: 11 * 60_000 })).toBe(true);
    expect(calls).toBe(2);
  });

  it("restores Agy modelProvider after an API-key run", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "agent-bridge-agy-provider-test-"));
    tempDirs.push(homeDir);
    const settingsDir = join(homeDir, ".gemini", "antigravity-cli");
    mkdirSync(settingsDir, { recursive: true });
    const settingsPath = join(settingsDir, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ modelProvider: "antigravity", model: "keep-me" }));

    await withAntigravityApiKeyProvider(homeDir, { GEMINI_API_KEY: "secret" }, async () => {
      const during = JSON.parse(readFileSync(settingsPath, "utf8"));
      expect(during).toEqual({ modelProvider: "gemini", model: "keep-me" });
    });

    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({ modelProvider: "antigravity", model: "keep-me" });
  });

  it("redacts configured provider credentials without redacting ordinary text", () => {
    const env = { ANTHROPIC_API_KEY: "claude-secret-572", XAI_API_KEY: "grok-secret-572" };
    const input = "claude-secret-572 ordinary grok-secret-572";
    const output = redactProviderApiKeySecrets(input, env);
    expect(output).toBe("[REDACTED_PROVIDER_CREDENTIAL] ordinary [REDACTED_PROVIDER_CREDENTIAL]");
    expect(output).not.toContain("secret-572");
  });
});
