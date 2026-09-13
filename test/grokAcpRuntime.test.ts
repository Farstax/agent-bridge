import * as acp from "@agentclientprotocol/sdk";
import { lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCliInvocation, parseCliResult } from "../src/cli.js";
import { runAcpTurn } from "../src/acp/client.js";
import { getLockedAcpRegistryEntry } from "../src/providers/acpRegistry.js";
import { resolveProviderRuntime } from "../src/providers/acpRuntime.js";
import {
  acpProviderDefaultSettingKey,
  hasAcpProviderDefaultIntent,
  setAcpProviderDefaultIntent,
} from "../src/acp/sessionConfig.js";
import { openDb } from "../src/db.js";
import { grokAcpPolicy } from "../src/providers/grokAcpPolicy.js";
import { getAcpProviderPolicy, isAcpBackedBot, supportsToolFreeMode } from "../src/providers/registry.js";
import type { ProviderInvocationRequest } from "../src/providers/types.js";

function request(overrides: Partial<ProviderInvocationRequest> = {}): ProviderInvocationRequest {
  return {
    prompt: "hello",
    sessionId: null,
    command: "grok",
    model: null,
    executionMode: "safe",
    outputFormat: "json",
    soulContext: null,
    attachments: [],
    outputDir: null,
    effort: null,
    toolMode: "default",
    ...overrides,
  };
}

describe("Grok ACP provider", () => {
  it("locks the official Registry distribution and selects it for execution", () => {
    expect(getLockedAcpRegistryEntry("grok")).toEqual(expect.objectContaining({
      id: "grok-build",
      version: "1.0.30",
      distribution: {
        npx: { package: "@xai-official/grok@1.0.30", args: ["agent", "stdio"] },
      },
    }));
    expect(getAcpProviderPolicy("grok")).toBe(grokAcpPolicy);
    expect(resolveProviderRuntime("grok", { BRIDGE_CURRENT_RELEASE_DIR: "/opt/agent-bridge" })).toEqual(expect.objectContaining({
      providerId: "grok",
      transport: "acp-stdio",
      executable: "/opt/agent-bridge/node_modules/.bin/grok",
      args: ["agent", "stdio"],
      versionArgs: ["--version"],
      runtimeIdentity: expect.stringMatching(/^acp:grok-build@1\.0\.30:[a-f0-9]{64}$/),
      toolFree: false,
      provisionalAnswers: true,
    }));

    const invocation = buildCliInvocation({
      bot: "grok",
      prompt: "hello",
      sessionId: null,
      command: "grok",
      model: null,
    });
    expect(invocation).toEqual({
      command: expect.stringMatching(/node_modules\/\.bin\/grok$/),
      args: ["agent", "stdio"],
      nativeSessionMode: "fresh",
      prompt: "hello",
      transport: "acp-stdio",
    });
  });

  it("keeps the bundled Grok bin symlink relative so release artifacts stay self-contained", () => {
    const link = join(process.cwd(), "node_modules", "@xai-official", "grok", "bin", "grok");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link).startsWith("/")).toBe(false);
  });

  it("honors GROK_ACP_COMMAND and empty GROK_ACP_ARGS overrides", () => {
    expect(resolveProviderRuntime("grok", {
      GROK_ACP_COMMAND: "/opt/xai/bin/grok",
      GROK_ACP_ARGS: "",
    })).toEqual(expect.objectContaining({
      executable: "/opt/xai/bin/grok",
      args: [],
      transport: "acp-stdio",
    }));
  });

  it("expresses model and effort as semantic ACP intents without provider-id translation", () => {
    expect(grokAcpPolicy.sessionSettings?.(request({
      model: null,
      effort: "xhigh",
    }), {
      GROK_MODEL_PREFERENCE: "grok-4.6,grok-4.5",
      GROK_EFFORT: "high",
    })).toEqual({
      config: [
        { category: "model", explicitValue: null, preferredValues: ["grok-4.6", "grok-4.5"] },
        { category: "thought_level", explicitValue: "xhigh", preferredValues: ["high"] },
      ],
    });
    expect(grokAcpPolicy.sessionSettings?.(request({ model: "grok-4.5" }), {})?.config).toEqual([
      { category: "model", explicitValue: "grok-4.5", preferredValues: [] },
    ]);
    expect(supportsToolFreeMode("grok")).toBe(false);
    expect(isAcpBackedBot("grok")).toBe(true);
    expect(isAcpBackedBot("cursor")).toBe(false);
    expect(grokAcpPolicy.steeringSupported).toBe(false);
  });

  it("keeps cached account auth authoritative over an optional API key", () => {
    const root = mkdtempSync(join(tmpdir(), "grok-acp-auth-precedence-"));
    const grokHome = join(root, ".grok");
    mkdirSync(grokHome, { recursive: true });
    writeFileSync(join(grokHome, "auth.json"), "{}\n", "utf8");
    try {
      expect(grokAcpPolicy.authenticateMethodId?.({
        HOME: root,
        XAI_API_KEY: "optional-unverified-key",
      })).toBe("cached_token");

      const customHome = join(root, "custom-grok");
      mkdirSync(customHome, { recursive: true });
      writeFileSync(join(customHome, "auth.json"), "{}\n", "utf8");
      expect(grokAcpPolicy.authenticateMethodId?.({
        HOME: join(root, "missing-home"),
        GROK_HOME: customHome,
        XAI_API_KEY: "optional-unverified-key",
      })).toBe("cached_token");

      const explicitAuthPath = join(root, "explicit-auth.json");
      writeFileSync(explicitAuthPath, "{}\n", "utf8");
      expect(grokAcpPolicy.authenticateMethodId?.({
        HOME: join(root, "missing-home"),
        GROK_AUTH_PATH: explicitAuthPath,
        XAI_API_KEY: "optional-unverified-key",
      })).toBe("cached_token");

      expect(grokAcpPolicy.authenticateMethodId?.({
        HOME: join(root, "missing-home"),
        XAI_API_KEY: "verified-or-provider-native-key",
      })).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("persists Grok provider-default as ACP policy so env preference is not applied", () => {
    setAcpProviderDefaultIntent("grok", "model", false);
    setAcpProviderDefaultIntent("grok", "thought_level", false);
    const db = openDb(":memory:");
    db.setSetting("grok", null);
    db.setSetting("effort:grok", null);
    expect(db.getSetting(acpProviderDefaultSettingKey("grok", "model"))).toBe("1");
    expect(db.getSetting(acpProviderDefaultSettingKey("grok", "thought_level"))).toBe("1");
    expect(hasAcpProviderDefaultIntent("grok", "model")).toBe(true);
    expect(hasAcpProviderDefaultIntent("grok", "thought_level")).toBe(true);
    expect(grokAcpPolicy.sessionSettings?.(request({ model: null, effort: null }), {
      GROK_MODEL_PREFERENCE: "grok-4.6,grok-4.5",
      GROK_EFFORT: "high",
    })).toEqual({
      config: [
        { category: "model", explicitValue: null, preferredValues: [], useProviderDefault: true },
        { category: "thought_level", explicitValue: null, preferredValues: [], useProviderDefault: true },
      ],
    });
  });

  it("rejects tool-free mode until a Grok ACP contract is proven", () => {
    expect(() => buildCliInvocation({
      bot: "grok",
      prompt: "hi",
      sessionId: null,
      command: "grok",
      toolMode: "none",
    })).toThrow(/Tool-free mode is not supported for grok/);
  });

  it("does not parse Grok ACP as native CLI output", () => {
    expect(() => parseCliResult({
      bot: "grok",
      stdout: "{\"type\":\"text\",\"data\":\"nope\"}\n",
    })).toThrow(/ACP structured results/);
  });

  it("keeps thought and tool updates out of the authoritative live answer", async () => {
    const agent = acp.agent({ name: "grok-policy-fixture" })
      .onRequest(acp.methods.agent.initialize, async () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: { loadSession: true },
        authMethods: [{ id: "cached_token", name: "cached_token" }],
      }))
      .onRequest(acp.methods.agent.authenticate, async () => ({}))
      .onRequest(acp.methods.agent.session.new, async () => ({
        sessionId: "grok-session",
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "grok-4.6",
            options: [{ value: "grok-4.6", name: "Grok 4.6" }],
          },
        ],
      }))
      .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
        await ctx.client.notify(acp.methods.client.session.update, {
          sessionId: ctx.params.sessionId,
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "secret-thought" },
          },
        });
        await ctx.client.notify(acp.methods.client.session.update, {
          sessionId: ctx.params.sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "t1",
            title: "shell",
            kind: "execute",
            status: "completed",
          },
        });
        await ctx.client.notify(acp.methods.client.session.update, {
          sessionId: ctx.params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "QUAL-OK" },
          },
        });
        return { stopReason: "end_turn" };
      });

    const result = await runAcpTurn({
      peer: agent,
      cwd: process.cwd(),
      conversationId: "bridge-conversation",
      runId: "run-grok",
      existingAcpSessionId: null,
      prompt: "hello",
      executionMode: "safe",
      authenticateMethodId: "cached_token",
      sessionConfig: grokAcpPolicy.sessionSettings?.(request({ model: "grok-4.6" }), {})?.config,
    });
    expect(result.liveText).toBe("QUAL-OK");
    expect(result.liveText).not.toContain("secret-thought");
    expect(result.acpSessionId).toBe("grok-session");
    expect(result.stopReason).toBe("end_turn");
  });
});
