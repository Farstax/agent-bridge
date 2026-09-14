import * as acp from "@agentclientprotocol/sdk";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { agyAcpPolicy } from "../src/providers/agyAcpPolicy.js";
import { getAcpProviderPolicy, isAcpBackedBot, supportsToolFreeMode } from "../src/providers/registry.js";
import type { ProviderInvocationRequest } from "../src/providers/types.js";

function request(overrides: Partial<ProviderInvocationRequest> = {}): ProviderInvocationRequest {
  return {
    prompt: "hello",
    sessionId: null,
    command: "agy_acp_server.par",
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

describe("Agy ACP provider", () => {
  it("locks the official Registry distribution and selects it for execution", () => {
    expect(getLockedAcpRegistryEntry("agy")).toEqual(expect.objectContaining({
      id: "antigravity-acp",
      version: "1.1.1",
      distribution: {
        binary: expect.objectContaining({
          "linux-x86_64": {
            archive: "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-agy_acp_server_1.1.1-linux-x86_64.zip",
            cmd: "./agy_acp_server.par",
            args: ["--uid="],
          },
        }),
      },
    }));
    expect(getAcpProviderPolicy("agy")).toBe(agyAcpPolicy);
    expect(resolveProviderRuntime("agy", { AGY_ACP_COMMAND: "/opt/agy/agy_acp_server.par" })).toEqual(expect.objectContaining({
      providerId: "agy",
      transport: "acp-stdio",
      executable: "/opt/agy/agy_acp_server.par",
      args: ["--uid="],
      versionArgs: ["--version"],
      runtimeIdentity: expect.stringMatching(/^acp:antigravity-acp@1\.1\.1:[a-f0-9]{64}$/),
      toolFree: true,
      provisionalAnswers: true,
    }));

    const invocation = buildCliInvocation({
      bot: "antigravity",
      prompt: "hello",
      sessionId: null,
      command: "agy_acp_server.par",
      model: null,
    });
    expect(invocation).toEqual({
      command: expect.stringMatching(/agy_acp_server\.par$/),
      args: ["--uid="],
      nativeSessionMode: "fresh",
      prompt: "hello",
      transport: "acp-stdio",
    });
    expect(invocation.args).not.toContain("--print");
  });

  it("honors AGY_ACP_COMMAND and empty AGY_ACP_ARGS overrides", () => {
    expect(resolveProviderRuntime("agy", {
      AGY_ACP_COMMAND: "/opt/agy/bin/agy_acp_server.par",
      AGY_ACP_ARGS: "",
    })).toEqual(expect.objectContaining({
      executable: "/opt/agy/bin/agy_acp_server.par",
      args: [],
      transport: "acp-stdio",
    }));
    expect(resolveProviderRuntime("agy", {})).toEqual(expect.objectContaining({
      executable: "agy_acp_server.par",
      args: ["--uid="],
      transport: "acp-stdio",
    }));
  });

  it("expresses model and effort as semantic ACP intents without provider-id translation", () => {
    expect(agyAcpPolicy.sessionSettings?.(request({
      model: null,
      effort: "high",
    }), {
      ANTIGRAVITY_MODEL_PREFERENCE: "gemini-3.8-flash,gemini-3.1-pro",
      ANTIGRAVITY_EFFORT: "medium",
    })).toEqual({
      config: [
        { category: "model", explicitValue: null, preferredValues: ["gemini-3.8-flash", "gemini-3.1-pro"] },
        { category: "thought_level", explicitValue: "high", preferredValues: ["medium"] },
      ],
    });
    expect(agyAcpPolicy.sessionSettings?.(request({ model: "gemini-3.1-pro" }), {})?.config).toEqual([
      { category: "model", explicitValue: "gemini-3.1-pro", preferredValues: [] },
    ]);
    expect(supportsToolFreeMode("antigravity")).toBe(true);
    expect(supportsToolFreeMode("agy")).toBe(true);
    expect(isAcpBackedBot("antigravity")).toBe(true);
    expect(isAcpBackedBot("agy")).toBe(true);
    expect(isAcpBackedBot("cursor")).toBe(false);
    expect(agyAcpPolicy.steeringSupported).toBe(false);
  });

  it("only requests oauth-personal authenticate when a cached antigravity-acp credential exists", () => {
    const root = mkdtempSync(join(tmpdir(), "agy-acp-auth-precedence-"));
    try {
      // No cached credential yet: must not request the interactive OAuth
      // method, or an ordinary Run would hang waiting on a browser login.
      expect(agyAcpPolicy.authenticateMethodId?.({ HOME: root })).toBeUndefined();

      const acpAuthDir = join(root, ".gemini", "antigravity-acp");
      mkdirSync(acpAuthDir, { recursive: true });
      writeFileSync(join(acpAuthDir, "acp_token.json"), "{}\n", "utf8");
      expect(agyAcpPolicy.authenticateMethodId?.({ HOME: root })).toBe("oauth-personal");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("persists Agy provider-default as ACP policy so env preference is not applied", () => {
    setAcpProviderDefaultIntent("antigravity", "model", false);
    setAcpProviderDefaultIntent("antigravity", "thought_level", false);
    const db = openDb(":memory:");
    db.setSetting("antigravity", null);
    db.setSetting("effort:antigravity", null);
    expect(db.getSetting(acpProviderDefaultSettingKey("antigravity", "model"))).toBe("1");
    expect(db.getSetting(acpProviderDefaultSettingKey("antigravity", "thought_level"))).toBe("1");
    expect(hasAcpProviderDefaultIntent("antigravity", "model")).toBe(true);
    expect(hasAcpProviderDefaultIntent("antigravity", "thought_level")).toBe(true);
    expect(agyAcpPolicy.sessionSettings?.(request({ model: null, effort: null }), {
      ANTIGRAVITY_MODEL_PREFERENCE: "gemini-3.8-flash,gemini-3.1-pro",
      ANTIGRAVITY_EFFORT: "high",
    })).toEqual({
      config: [
        { category: "model", explicitValue: null, preferredValues: [], useProviderDefault: true },
        { category: "thought_level", explicitValue: null, preferredValues: [], useProviderDefault: true },
      ],
    });
  });

  it("does not parse Agy ACP as native stream-json CLI output", () => {
    expect(() => parseCliResult({
      bot: "antigravity",
      stdout: JSON.stringify({
        event: "result",
        result: { conversation_id: "11111111-1111-4111-8111-111111111111", status: "SUCCESS", response: "nope" },
      }) + "\n",
    })).toThrow(/ACP structured results/);
  });

  it("owns no provider-specific ACP runtime or native settings writers", () => {
    expect(existsSync("src/providers/agyAcpRuntime.ts")).toBe(false);
    expect(existsSync("src/providers/antigravityRuntime.ts")).toBe(false);
    expect(existsSync("src/providers/antigravitySerializedRunner.ts")).toBe(false);
    const engine = readFileSync("src/engine.ts", "utf8");
    expect(engine).not.toContain("_retryAntigravityFreshSession");
    expect(engine).not.toContain("writeAntigravityModelSettings");
    expect(engine).not.toContain("setAntigravityModel");
    expect(readFileSync("src/providers/agyAcpPolicy.ts", "utf8")).not.toContain("writeModelSettings");
    expect(readFileSync("src/providers/agyAcpPolicy.ts", "utf8")).not.toContain("writeAntigravityModelSettings");
  });

  it("keeps thought and tool updates out of the authoritative live answer", async () => {
    const agent = acp.agent({ name: "agy-policy-fixture" })
      .onRequest(acp.methods.agent.initialize, async () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: { loadSession: true },
        authMethods: [{ id: "oauth-personal", name: "oauth-personal" }],
      }))
      .onRequest(acp.methods.agent.authenticate, async () => ({}))
      .onRequest(acp.methods.agent.session.new, async () => ({
        sessionId: "agy-session",
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "gemini-3.8-flash",
            options: [{ value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" }],
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
      runId: "run-agy",
      existingAcpSessionId: null,
      prompt: "hello",
      executionMode: "safe",
      authenticateMethodId: "oauth-personal",
      sessionConfig: agyAcpPolicy.sessionSettings?.(request({ model: "gemini-3.8-flash" }), {})?.config,
    });
    expect(result.liveText).toBe("QUAL-OK");
    expect(result.liveText).not.toContain("secret-thought");
    expect(result.acpSessionId).toBe("agy-session");
    expect(result.stopReason).toBe("end_turn");
  });
});
