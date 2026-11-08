import * as acp from "@agentclientprotocol/sdk/unstable";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCliInvocation, parseCliResult } from "../src/cli.js";
import { runAcpTurn } from "../src/acp/client.js";
import { getLockedAcpRegistryEntry } from "../src/providers/acpRegistry.js";
import { AGY_ACP_VERSION_TIMEOUT_MS, assertAgyAcpVersion, readAgyAcpVersion } from "../src/providers/agyAcpConfig.js";
import { resolveProviderRuntime } from "../src/providers/acpRuntime.js";
import {
  acpProviderDefaultSettingKey,
  hasAcpProviderDefaultIntent,
  setAcpProviderDefaultIntent,
} from "../src/acp/sessionConfig.js";
import { openDb } from "../src/db.js";
import { agyAcpPolicy } from "../src/providers/agyAcpPolicy.js";
import { resolveAgyAcpAuthPaths } from "../src/providers/agyAvailability.js";
import { getAcpProviderPolicy, isAcpBackedBot, supportsToolFreeMode } from "../src/providers/registry.js";
import type { ProviderInvocationRequest } from "../src/providers/types.js";

function request(overrides: Partial<ProviderInvocationRequest> = {}): ProviderInvocationRequest {
  return {
    prompt: "hello", sessionId: null, command: "agy", model: null,
    executionMode: "safe", outputFormat: "json", soulContext: null,
    attachments: [], outputDir: null, effort: null, toolMode: "default",
    ...overrides,
  };
}

describe("Agy ACP provider", () => {
  it("locks the official Google 1.5.2 archive and launches agy acp in the generic ACP runtime", () => {
    expect(getLockedAcpRegistryEntry("agy")).toEqual(expect.objectContaining({
      id: "antigravity-acp",
      version: "1.5.2",
      distribution: { binary: expect.objectContaining({
        "linux-x86_64": {
          archive: "https://github.com/google-antigravity/antigravity-cli/releases/download/1.5.2/agy_cli_linux_x64.tar.gz",
          sha256: "da696a8dc6122a63d5ffbdd21b02c8a62d5361fba0ed7d3bc2d2619889e62711",
          cmd: "./agy", args: ["acp"],
        },
      }) },
    }));
    expect(getAcpProviderPolicy("agy")).toBe(agyAcpPolicy);
    expect(resolveProviderRuntime("agy", { AGY_ACP_COMMAND: "/opt/agy/agy" })).toEqual(expect.objectContaining({
      providerId: "agy", transport: "acp-stdio", executable: "/opt/agy/agy",
      args: ["acp"], versionArgs: ["--version"],
      runtimeIdentity: expect.stringMatching(/^acp:antigravity-acp@1\.5\.2:[a-f0-9]{64}$/),
      toolFree: true, provisionalAnswers: true,
    }));
    const invocation = buildCliInvocation({
      bot: "antigravity", prompt: "hello", sessionId: null, command: "agy", model: null,
    });
    expect(invocation).toEqual({
      command: expect.stringMatching(/agy$/), args: ["acp"],
      nativeSessionMode: "fresh", prompt: "hello", transport: "acp-stdio",
    });
  });

  it("uses bounded version verification and fails closed on an unexpected CLI", () => {
    let options: { timeout?: number } | undefined;
    expect(readAgyAcpVersion("agy", ((command, args, received) => {
      expect(command).toBe("agy");
      expect(args).toEqual(["--version"]);
      options = received as { timeout?: number };
      return "agy 1.5.2";
    }) as never)).toContain("1.5.2");
    expect(options?.timeout).toBe(AGY_ACP_VERSION_TIMEOUT_MS);
    expect(() => assertAgyAcpVersion("agy", "1.5.2", () => "agy 1.2.1"))
      .toThrow(/expects 1\.5\.2, observed 1\.2\.1/);
    expect(() => assertAgyAcpVersion("agy", "1.5.2", () => "unknown"))
      .toThrow(/observed unknown/);
    expect(() => assertAgyAcpVersion("agy", "1.5.2", () => { throw new Error("not installed"); }))
      .toThrow(/could not be version-verified: not installed/);
    expect(() => assertAgyAcpVersion("agy", "1.5.2", () => "agy version 1.5.2")).not.toThrow();
    expect(() => assertAgyAcpVersion("agy", "1.5.2", () => "agy v1.5.2")).not.toThrow();
    for (const displayed of ["agy 1.5.2.1", "agy 1.5.20", "agy 11.5.2", "agy 1.5.2-rc1"]) {
      expect(() => assertAgyAcpVersion("agy", "1.5.2", () => displayed)).toThrow(/version mismatch|observed unknown/);
    }
  });

  it("honours explicit command and argument overrides and needs no external harness", () => {
    expect(resolveProviderRuntime("agy", {
      AGY_ACP_COMMAND: "/opt/agy/bin/agy", AGY_ACP_ARGS: "",
    })).toEqual(expect.objectContaining({
      executable: "/opt/agy/bin/agy", args: [], transport: "acp-stdio",
    }));
    expect(resolveProviderRuntime("agy", {})).toEqual(expect.objectContaining({
      executable: "agy", args: ["acp"], transport: "acp-stdio",
    }));
    expect(agyAcpPolicy.buildChildEnv).toBeUndefined();
    expect(agyAcpPolicy.authenticateMethodId).toBeUndefined();
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
    expect(agyAcpPolicy.steeringSupported).toBe(false);
  });

  it("prefers official CLI cached sign-in and never invokes interactive OAuth during a Run", () => {
    const root = mkdtempSync(join(tmpdir(), "agy-acp-auth-precedence-"));
    try {
      expect(agyAcpPolicy.authenticateMethodId).toBeUndefined();
      const authPaths = resolveAgyAcpAuthPaths(root, { HOME: root });
      expect(authPaths).toContain(join(root, ".gemini", "oauth_creds.json"));
      const dir = join(root, ".gemini");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "oauth_creds.json"), "{}\n", "utf8");
      expect(authPaths.some(existsSync)).toBe(true);
      expect(agyAcpPolicy.authenticateMethodId).toBeUndefined();
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
