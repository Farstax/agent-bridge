import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PROVIDER_API_KEY_AUTH,
  clearProviderApiKeyVerificationCache,
  filterProviderCredentialEnv,
  getProviderApiKeyCapability,
  isProviderApiKeyVerified,
  redactProviderApiKeySecrets,
  verifyConfiguredProviderApiKeys,
  verifyProviderApiKey,
  withAntigravityApiKeyProvider,
  type ProviderApiKeyProbeExecutor,
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

  it.each(providerCases)("requires a successful bounded native probe for $provider", async ({ provider, envVar, commandEnv }) => {
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
    const execFile: ProviderApiKeyProbeExecutor = async (command, args, options) => {
      call = { command, args, env: options.env, timeout: options.timeout };
      if (provider === "agy") {
        const isolatedHome = String(options.env.HOME);
        expect(isolatedHome).not.toBe(homeDir);
        const settings = JSON.parse(readFileSync(join(isolatedHome, ".gemini", "antigravity-cli", "settings.json"), "utf8"));
        expect(settings.modelProvider).toBe("gemini");
      }
    };

    await expect(verifyProviderApiKey(provider, { env, execFile, useCache: false })).resolves.toBe(true);
    expect(call).not.toBeNull();
    expect(call!.command).toBe(`fake-${provider}`);
    expect(call!.args.join(" ")).not.toContain(apiKey);
    expect(call!.env[envVar]).toBe(apiKey);
    expect(call!.env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    if (envVar !== "ANTHROPIC_AUTH_TOKEN") expect(call!.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(call!.timeout).toBe(15_000);
  });

  it.each(providerCases)("does not treat a non-empty $envVar as proof for $provider", async ({ provider, envVar }) => {
    const env = { [envVar]: `invalid-${provider}-572` };
    const execFile: ProviderApiKeyProbeExecutor = async () => {
      throw new Error("provider rejected credential");
    };
    await expect(verifyProviderApiKey(provider, { env, execFile, useCache: false })).resolves.toBe(false);
    expect(isProviderApiKeyVerified(provider, env)).toBe(false);
  });

  it("does not probe when the key is missing or blank", async () => {
    let calls = 0;
    const execFile: ProviderApiKeyProbeExecutor = async () => {
      calls += 1;
    };
    await expect(verifyProviderApiKey("claude", { env: {}, execFile, useCache: false })).resolves.toBe(false);
    await expect(verifyProviderApiKey("claude", { env: { ANTHROPIC_API_KEY: "   " }, execFile, useCache: false })).resolves.toBe(false);
    expect(calls).toBe(0);
  });

  it("caches successful verification for the exact key fingerprint", async () => {
    let calls = 0;
    const execFile: ProviderApiKeyProbeExecutor = async () => {
      calls += 1;
    };
    const env = { CURSOR_API_KEY: "cursor-cache-key" };

    await expect(verifyProviderApiKey("cursor", { env, execFile })).resolves.toBe(true);
    await expect(verifyProviderApiKey("cursor", { env, execFile })).resolves.toBe(true);
    expect(calls).toBe(1);
    expect(isProviderApiKeyVerified("cursor", env)).toBe(true);

    const changedEnv = { CURSOR_API_KEY: "cursor-cache-key-2" };
    expect(isProviderApiKeyVerified("cursor", changedEnv)).toBe(false);
    await expect(verifyProviderApiKey("cursor", { env: changedEnv, execFile })).resolves.toBe(true);
    expect(calls).toBe(2);
  });

  it("withholds an unverified candidate key and unrelated provider secrets from runtime children", async () => {
    const env = {
      CODEX_API_KEY: "codex-candidate",
      OPENAI_API_KEY: "legacy-codex-secret",
      ANTHROPIC_API_KEY: "unrelated-claude-secret",
    };
    const before = filterProviderCredentialEnv("codex", env);
    expect(before.CODEX_API_KEY).toBeUndefined();
    expect(before.OPENAI_API_KEY).toBe("legacy-codex-secret");
    expect(before.ANTHROPIC_API_KEY).toBeUndefined();

    const execFile: ProviderApiKeyProbeExecutor = async () => undefined;
    await expect(verifyProviderApiKey("codex", { env, execFile })).resolves.toBe(true);
    const after = filterProviderCredentialEnv("codex", env);
    expect(after.CODEX_API_KEY).toBe("codex-candidate");
    expect(after.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("forces the temporary background-task mitigation only into Claude runtime children", () => {
    const env = {
      PATH: "/usr/bin",
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "0",
    };

    const claude = filterProviderCredentialEnv("claude", env);
    expect(claude.PATH).toBe("/usr/bin");
    expect(claude.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe("1");

    expect(filterProviderCredentialEnv("codex", env).CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBeUndefined();
    expect(filterProviderCredentialEnv("antigravity", env).CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBeUndefined();
    expect(filterProviderCredentialEnv(undefined, env).CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBeUndefined();
  });

  it("verifies configured providers in parallel without blocking on one probe", async () => {
    const env = { CODEX_API_KEY: "codex-key", ANTHROPIC_API_KEY: "claude-key" };
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const execFile: ProviderApiKeyProbeExecutor = async (command) => {
      started.push(command);
      await gate;
    };

    const verification = verifyConfiguredProviderApiKeys({
      env: { ...env, CODEX_COMMAND: "codex-probe", CLAUDE_COMMAND: "claude-probe" },
      execFile,
      useCache: false,
    });
    await Promise.resolve();
    expect(started.sort()).toEqual(["claude-probe", "codex-probe"]);
    release();
    await verification;
  });

  it("restores Agy modelProvider after a verified API-key run", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "agent-bridge-agy-provider-test-"));
    tempDirs.push(homeDir);
    const settingsDir = join(homeDir, ".gemini", "antigravity-cli");
    mkdirSync(settingsDir, { recursive: true });
    const settingsPath = join(settingsDir, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ modelProvider: "antigravity", model: "keep-me" }));
    const env = { GEMINI_API_KEY: "secret" };
    await verifyProviderApiKey("agy", { env, execFile: async () => undefined });

    await withAntigravityApiKeyProvider(homeDir, env, async () => {
      const during = JSON.parse(readFileSync(settingsPath, "utf8"));
      expect(during).toEqual({ modelProvider: "gemini", model: "keep-me" });
    });

    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({ modelProvider: "antigravity", model: "keep-me" });
  });

  it("keeps Agy account settings unchanged even when a verified optional key is configured", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "agent-bridge-agy-account-precedence-"));
    tempDirs.push(homeDir);
    const settingsDir = join(homeDir, ".gemini", "antigravity-cli");
    mkdirSync(settingsDir, { recursive: true });
    const settingsPath = join(settingsDir, "settings.json");
    const tokenPath = join(settingsDir, "antigravity-oauth-token");
    writeFileSync(settingsPath, JSON.stringify({ modelProvider: "antigravity", model: "keep-me" }));
    writeFileSync(tokenPath, "account-token");
    const env = { GEMINI_API_KEY: "verified-but-optional" };
    await verifyProviderApiKey("agy", { env, execFile: async () => undefined });

    await withAntigravityApiKeyProvider(homeDir, env, async () => {
      expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({ modelProvider: "antigravity", model: "keep-me" });
    });
  });

  it("redacts configured provider credentials without redacting ordinary text", () => {
    const env = { ANTHROPIC_API_KEY: "claude-secret-572", XAI_API_KEY: "grok-secret-572" };
    const input = "claude-secret-572 ordinary grok-secret-572";
    const output = redactProviderApiKeySecrets(input, env);
    expect(output).toBe("[REDACTED_PROVIDER_CREDENTIAL] ordinary [REDACTED_PROVIDER_CREDENTIAL]");
    expect(output).not.toContain("secret-572");
  });
});
