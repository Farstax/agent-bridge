import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadBotsConfig } from "../src/config.js";
import { filterProviderCredentialEnv } from "../src/providers/apiKeyAuth.js";
import {
  resolveCustomAcpProviderRuntime,
  runAcpProviderTurn,
  type ResolvedProviderRuntime,
} from "../src/providers/acpRuntime.js";
import { runDoctor } from "../src/providers/doctor.js";
import { getAvailableCliKinds } from "../src/interactiveCliAuth.js";
import { interactiveChainKinds, parseCliChain } from "../src/providers/selection.js";
import { lookupProviderSession, persistProviderSession } from "../src/providers/sessionRuntime.js";
import type { BridgeDb } from "../src/db.js";

const fakeAgent = fileURLToPath(new URL("./support/fakeSecondAcpAgent.ts", import.meta.url));
const tsxCli = join(process.cwd(), "node_modules/tsx/dist/cli.mjs");

function customEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    CUSTOM_ACP_COMMAND: process.execPath,
    CUSTOM_ACP_ARGS_JSON: JSON.stringify([tsxCli, fakeAgent]),
    CUSTOM_ACP_AUTH_METHOD_ID: "workspace-token",
    ...extra,
  };
}

function request(prompt: string, sessionId: string | null = null) {
  return {
    prompt,
    sessionId,
    command: process.execPath,
    model: null,
    executionMode: "safe" as const,
    outputFormat: "json" as const,
    soulContext: null,
    attachments: [],
    outputDir: null,
    effort: null,
    toolMode: "default" as const,
  };
}

describe("custom ACP provider", () => {
  it("validates structured launch configuration and fingerprints execution-affecting changes", () => {
    expect(() => loadBotsConfig({ CUSTOM_ACP_ARGS_JSON: "[]" }))
      .toThrow(/CUSTOM_ACP_COMMAND is required/);
    expect(() => loadBotsConfig({ CUSTOM_ACP_COMMAND: "/bin/agent", CUSTOM_ACP_ARGS_JSON: "not-json" }))
      .toThrow(/CUSTOM_ACP_ARGS_JSON/);
    expect(() => loadBotsConfig({ CUSTOM_ACP_COMMAND: "/bin/agent", CUSTOM_ACP_ARGS_JSON: "[1]" }))
      .toThrow(/JSON string array/);

    const first = resolveCustomAcpProviderRuntime({
      CUSTOM_ACP_COMMAND: "/bin/agent",
      CUSTOM_ACP_ARGS_JSON: '["serve"]',
    });
    const same = resolveCustomAcpProviderRuntime({
      CUSTOM_ACP_COMMAND: "/bin/agent",
      CUSTOM_ACP_ARGS_JSON: '["serve"]',
    });
    const changed = resolveCustomAcpProviderRuntime({
      CUSTOM_ACP_COMMAND: "/bin/agent",
      CUSTOM_ACP_ARGS_JSON: '["serve","--changed"]',
    });

    expect(first).toMatchObject({
      providerId: "custom-acp",
      transport: "acp-stdio",
      executable: "/bin/agent",
      args: ["serve"],
      versionArgs: [],
      selectedVersion: null,
      registryAgentId: null,
      distribution: null,
      toolFree: false,
      provisionalAnswers: false,
      runtimeIdentity: expect.stringMatching(/^custom-acp:[a-f0-9]{64}$/),
    });
    expect(same.runtimeIdentity).toBe(first.runtimeIdentity);
    expect(changed.runtimeIdentity).not.toBe(first.runtimeIdentity);
  });

  it("namespaces persisted sessions by custom runtime identity", () => {
    const first = resolveCustomAcpProviderRuntime({
      CUSTOM_ACP_COMMAND: "/bin/agent",
      CUSTOM_ACP_ARGS_JSON: '["serve"]',
    });
    const changed = resolveCustomAcpProviderRuntime({
      CUSTOM_ACP_COMMAND: "/bin/agent",
      CUSTOM_ACP_ARGS_JSON: '["serve","--changed"]',
    });
    const bindings = new Map<string, string>();
    const db = {
      getAcpSessionBinding: vi.fn((_conversationId: string, providerId: string) => {
        const acpSessionId = bindings.get(providerId);
        return acpSessionId ? { acpSessionId } : null;
      }),
      putAcpSessionBinding: vi.fn((binding: { providerId: string; acpSessionId: string }) => {
        bindings.set(binding.providerId, binding.acpSessionId);
      }),
      clearAcpSessionBinding: vi.fn(),
      getSession: vi.fn(),
      setSession: vi.fn(),
    } as unknown as BridgeDb;
    const resolveFirst = () => first as ResolvedProviderRuntime;
    const resolveChanged = () => changed as ResolvedProviderRuntime;

    persistProviderSession(db, "conversation", "custom-acp", "session-one", "run-1", resolveFirst);
    expect(lookupProviderSession(db, "conversation", "custom-acp", resolveFirst)).toBe("session-one");
    expect(lookupProviderSession(db, "conversation", "custom-acp", resolveChanged)).toBeNull();
    expect(db.putAcpSessionBinding).toHaveBeenCalledWith(expect.objectContaining({
      providerId: first.runtimeIdentity,
      acpSessionId: "session-one",
    }));
  });

  it("strips every known first-party provider credential from the custom child environment", () => {
    const child = filterProviderCredentialEnv("custom-acp", {
      PATH: "/usr/bin",
      CUSTOM_VISIBLE: "yes",
      CODEX_API_KEY: "codex",
      OPENAI_API_KEY: "openai",
      ANTHROPIC_API_KEY: "anthropic",
      ANTHROPIC_AUTH_TOKEN: "claude-token",
      GEMINI_API_KEY: "gemini",
      GOOGLE_API_KEY: "google",
      XAI_API_KEY: "xai",
      GROK_CODE_XAI_API_KEY: "grok",
      CURSOR_API_KEY: "cursor",
      CURSOR_AUTH_TOKEN: "cursor-token",
    });

    expect(child.PATH).toBe("/usr/bin");
    expect(child.CUSTOM_VISIBLE).toBe("yes");
    for (const key of [
      "CODEX_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN",
      "GEMINI_API_KEY", "GOOGLE_API_KEY", "XAI_API_KEY", "GROK_CODE_XAI_API_KEY",
      "CURSOR_API_KEY", "CURSOR_AUTH_TOKEN",
    ]) {
      expect(child[key]).toBeUndefined();
    }
  });

  it("is explicitly selectable and chainable without entering the default fallback", () => {
    expect(interactiveChainKinds()).toContain("custom-acp");
    expect(parseCliChain(undefined, {
      allowed: interactiveChainKinds(),
      fallback: ["codex", "claude", "antigravity", "grok", "cursor"],
    })).not.toContain("custom-acp");
    expect(parseCliChain("custom-acp,codex", {
      allowed: interactiveChainKinds(),
      fallback: ["codex"],
    })).toEqual(["custom-acp", "codex"]);

    const available = getAvailableCliKinds({
      env: { CUSTOM_ACP_COMMAND: "/bin/custom-agent" },
      exists: () => false,
      commandExists: (command) => command === "/bin/custom-agent",
      failedProviders: new Set(),
    });
    expect(available.has("custom-acp")).toBe(true);
  });

  it("doctor distinguishes unconfigured, malformed, missing and available custom ACP without version probing", () => {
    const voice = () => ({ status: "disabled" as const, reasonCode: "voice_transcription_disabled" as const });
    const unconfigured = runDoctor({
      env: {},
      commandExists: () => false,
      inspectVoiceRuntime: voice,
    }).providers.find((provider) => provider.id === "custom-acp");
    expect(unconfigured).toMatchObject({ status: "missing", reason: expect.stringContaining("not configured") });

    const malformed = runDoctor({
      env: { CUSTOM_ACP_COMMAND: "/bin/custom", CUSTOM_ACP_ARGS_JSON: "{" },
      commandExists: () => false,
      inspectVoiceRuntime: voice,
    }).providers.find((provider) => provider.id === "custom-acp");
    expect(malformed).toMatchObject({ status: "invalid", reason: expect.stringContaining("CUSTOM_ACP_ARGS_JSON") });

    const missing = runDoctor({
      env: { CUSTOM_ACP_COMMAND: "/bin/custom" },
      commandExists: () => false,
      inspectVoiceRuntime: voice,
    }).providers.find((provider) => provider.id === "custom-acp");
    expect(missing).toMatchObject({ status: "missing", executable: "/bin/custom" });

    const inspectVersion = vi.fn(() => null);
    const available = runDoctor({
      env: { CUSTOM_ACP_COMMAND: "/bin/custom" },
      commandExists: (command) => command === "/bin/custom",
      inspectVersion,
      inspectVoiceRuntime: voice,
    }).providers.find((provider) => provider.id === "custom-acp");
    expect(available).toMatchObject({ status: "available", executable: "/bin/custom", runtime: "acp" });
    expect(available?.version).toBeUndefined();
    expect(inspectVersion).not.toHaveBeenCalledWith("/bin/custom", expect.anything());
  });

  it("completes a fresh turn through the shared ACP runtime and fails closed on unsupported auth", async () => {
    const env = customEnv();
    const retained: unknown[] = [];
    const result = await runAcpProviderTurn(
      "custom-acp",
      request("answer"),
      process.cwd(),
      {
        bot: "custom-acp",
        timeoutMs: 5_000,
        idleTimeoutMs: 5_000,
        contextEnv: env,
        eventContext: { runId: "custom-run", bot: "custom-acp", chatId: "custom", chatKey: "custom" },
        onEvent: (event) => retained.push(event),
      },
      { conversationId: "custom-conversation", runId: "custom-run" },
    );
    expect(result).toMatchObject({
      text: "fixture parent answer",
      sessionId: "fixture-root-session",
      stopReason: "end_turn",
      telemetry: { provider: "custom-acp", inputTokens: 7, outputTokens: 3 },
    });
    expect(JSON.stringify(retained)).toContain("fixture-child-session");

    await expect(runAcpProviderTurn(
      "custom-acp",
      request("answer"),
      process.cwd(),
      {
        bot: "custom-acp",
        timeoutMs: 5_000,
        idleTimeoutMs: 5_000,
        contextEnv: customEnv({ CUSTOM_ACP_AUTH_METHOD_ID: "unsupported-method" }),
      },
      { conversationId: "custom-auth-fail", runId: "custom-auth-fail" },
    )).rejects.toThrow(/did not advertise authentication method/);
  }, 20_000);
});
