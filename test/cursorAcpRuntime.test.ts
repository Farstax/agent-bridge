import * as acp from "@agentclientprotocol/sdk";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { cursorAcpPolicy } from "../src/providers/cursorAcpPolicy.js";
import { assertCursorAcpVersion, CURSOR_ACP_VERSION } from "../src/providers/cursorAcpConfig.js";
import { getAcpProviderPolicy, isAcpBackedBot, supportsToolFreeMode } from "../src/providers/registry.js";
import type { ProviderInvocationRequest } from "../src/providers/types.js";

function request(overrides: Partial<ProviderInvocationRequest> = {}): ProviderInvocationRequest {
  return {
    prompt: "hello",
    sessionId: null,
    command: "cursor-agent",
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

describe("Cursor ACP provider", () => {
  it("locks the official Registry distribution and selects it for execution", () => {
    expect(getLockedAcpRegistryEntry("cursor")).toEqual(expect.objectContaining({
      id: "cursor",
      version: CURSOR_ACP_VERSION,
      distribution: {
        binary: expect.objectContaining({
          "linux-x86_64": {
            archive: "https://downloads.cursor.com/lab/2026.09.08-6caf4ff/linux/x64/agent-cli-package.tar.gz",
            cmd: "./dist-package/cursor-agent",
            args: ["acp"],
          },
        }),
      },
    }));
    expect(getAcpProviderPolicy("cursor")).toBe(cursorAcpPolicy);
    expect(resolveProviderRuntime("cursor", {})).toEqual(expect.objectContaining({
      providerId: "cursor",
      transport: "acp-stdio",
      executable: "cursor-agent",
      args: ["acp"],
      versionArgs: ["--version"],
      runtimeIdentity: expect.stringMatching(/^acp:cursor@2026\.09\.08-6caf4ff:[a-f0-9]{64}$/),
      toolFree: false,
      provisionalAnswers: true,
    }));

    const invocation = buildCliInvocation({
      bot: "cursor",
      prompt: "hello",
      sessionId: null,
      command: "cursor-agent",
      model: null,
    });
    expect(invocation).toEqual({
      command: "cursor-agent",
      args: ["acp"],
      nativeSessionMode: "fresh",
      prompt: "hello",
      transport: "acp-stdio",
    });
    expect(invocation.args).not.toContain("-p");
    expect(invocation.args).not.toContain("--output-format");
    expect(invocation.args).not.toContain("json");
  });

  it("honors CURSOR_ACP_COMMAND and empty CURSOR_ACP_ARGS overrides", () => {
    expect(resolveProviderRuntime("cursor", {
      CURSOR_ACP_COMMAND: "/opt/cursor/bin/cursor-agent",
      CURSOR_ACP_ARGS: "",
    })).toEqual(expect.objectContaining({
      executable: "/opt/cursor/bin/cursor-agent",
      args: [],
      transport: "acp-stdio",
    }));
  });

  it("expresses model and effort as semantic ACP intents without provider-id translation", () => {
    expect(cursorAcpPolicy.sessionSettings?.(request({
      model: null,
      effort: "xhigh",
    }), {
      CURSOR_MODEL_PREFERENCE: "composer-2.5,auto",
      CURSOR_EFFORT: "high",
    })).toEqual({
      modeId: "ask",
      config: [
        { category: "model", explicitValue: null, preferredValues: ["composer-2.5", "auto"] },
        { category: "thought_level", explicitValue: "xhigh", preferredValues: ["high"] },
      ],
    });
    expect(cursorAcpPolicy.sessionSettings?.(request({ model: "composer-2.5" }), {})?.config).toEqual([
      { category: "model", explicitValue: "composer-2.5", preferredValues: [] },
    ]);
    expect(supportsToolFreeMode("cursor")).toBe(false);
    expect(isAcpBackedBot("cursor")).toBe(true);
    expect(cursorAcpPolicy.steeringSupported).toBe(false);
    // No cached login and no API key: must not request cursor_login (it hangs
    // indefinitely with no cached credential -- see the dedicated auth test
    // below), and must not invent an API-key auth method either.
    expect(cursorAcpPolicy.authenticateMethodId?.({ HOME: "/no/such/home" })).toBeUndefined();
    expect(cursorAcpPolicy.authenticateMethodId?.({ HOME: "/no/such/home", CURSOR_API_KEY: "cursor-test" })).toBeUndefined();
  });

  it("only requests cursor_login authenticate when a cached Cursor login exists", () => {
    const root = mkdtempSync(join(tmpdir(), "cursor-acp-auth-precedence-"));
    try {
      expect(cursorAcpPolicy.authenticateMethodId?.({ HOME: root })).toBeUndefined();

      const configDir = join(root, ".config", "cursor");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, "auth.json"), "{}\n", "utf8");
      expect(cursorAcpPolicy.authenticateMethodId?.({ HOME: root })).toBe("cursor_login");

      // An unverified optional API key must not suppress the cached login.
      expect(cursorAcpPolicy.authenticateMethodId?.({ HOME: root, CURSOR_API_KEY: "unverified-key" })).toBe("cursor_login");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("persists Cursor provider-default as ACP policy so env preference is not applied", () => {
    setAcpProviderDefaultIntent("cursor", "model", false);
    setAcpProviderDefaultIntent("cursor", "thought_level", false);
    const db = openDb(":memory:");
    db.setSetting("cursor", null);
    db.setSetting("effort:cursor", null);
    expect(db.getSetting(acpProviderDefaultSettingKey("cursor", "model"))).toBe("1");
    expect(db.getSetting(acpProviderDefaultSettingKey("cursor", "thought_level"))).toBe("1");
    expect(hasAcpProviderDefaultIntent("cursor", "model")).toBe(true);
    expect(hasAcpProviderDefaultIntent("cursor", "thought_level")).toBe(true);
    expect(cursorAcpPolicy.sessionSettings?.(request({ model: null, effort: null }), {
      CURSOR_MODEL_PREFERENCE: "composer-2.5,auto",
      CURSOR_EFFORT: "high",
    })).toEqual({
      modeId: "ask",
      config: [
        { category: "model", explicitValue: null, preferredValues: [], useProviderDefault: true },
        { category: "thought_level", explicitValue: null, preferredValues: [], useProviderDefault: true },
      ],
    });
  });

  it("maps safe and trusted execution to Cursor's advertised ACP modes", () => {
    expect(cursorAcpPolicy.sessionSettings?.(request({ executionMode: "safe" }), {} )?.modeId).toBe("ask");
    expect(cursorAcpPolicy.sessionSettings?.(request({ executionMode: "trusted" }), {} )?.modeId).toBe("agent");
  });

  it("rejects tool-free mode until a Cursor ACP contract is proven", () => {
    expect(() => buildCliInvocation({
      bot: "cursor",
      prompt: "hi",
      sessionId: null,
      command: "cursor-agent",
      toolMode: "none",
    })).toThrow(/Tool-free mode is not supported for cursor/);
  });

  it("does not parse Cursor ACP as native CLI output", () => {
    expect(() => parseCliResult({
      bot: "cursor",
      stdout: "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"nope\",\"session_id\":\"sess-1\"}\n",
    })).toThrow(/ACP structured results/);
  });

  it("keeps thought and tool updates out of the authoritative live answer", async () => {
    const agent = acp.agent({ name: "cursor-policy-fixture" })
      .onRequest(acp.methods.agent.initialize, async () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: { loadSession: true },
        authMethods: [{ id: "cursor_login", name: "cursor_login" }],
      }))
      .onRequest(acp.methods.agent.authenticate, async () => ({}))
      .onRequest(acp.methods.agent.session.new, async () => ({
        sessionId: "cursor-session",
        modes: {
          currentModeId: "ask",
          availableModes: [
            { id: "agent", name: "Agent" },
            { id: "plan", name: "Plan" },
            { id: "ask", name: "Ask" },
          ],
        },
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "composer-2.5",
            options: [{ value: "composer-2.5", name: "Composer 2.5" }],
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
      runId: "run-cursor",
      existingAcpSessionId: null,
      prompt: "hello",
      executionMode: "safe",
      authenticateMethodId: "cursor_login",
      sessionModeId: cursorAcpPolicy.sessionSettings?.(request({ model: "composer-2.5" }), {})?.modeId,
      sessionConfig: cursorAcpPolicy.sessionSettings?.(request({ model: "composer-2.5" }), {})?.config,
    });
    expect(result.liveText).toBe("QUAL-OK");
    expect(result.liveText).not.toContain("secret-thought");
    expect(result.acpSessionId).toBe("cursor-session");
    expect(result.stopReason).toBe("end_turn");
  });

  it("classifies Cursor's capacity completion as a provider error", async () => {
    const agent = acp.agent({ name: "cursor-capacity-fixture" })
      .onRequest(acp.methods.agent.initialize, async () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {},
      }))
      .onRequest(acp.methods.agent.session.new, async () => ({
        sessionId: "cursor-capacity-session",
        modes: {
          currentModeId: "ask",
          availableModes: [{ id: "ask", name: "Ask" }],
        },
      }))
      .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
        await ctx.client.notify(acp.methods.client.session.update, {
          sessionId: ctx.params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Upgrade your plan to continue" },
          },
        });
        return { stopReason: "end_turn" };
      });

    const error = cursorAcpPolicy.detectTurnError?.(await runAcpTurn({
      peer: agent,
      cwd: process.cwd(),
      conversationId: "bridge-capacity",
      runId: "run-capacity",
      existingAcpSessionId: null,
      prompt: "hello",
      executionMode: "safe",
      sessionModeId: "ask",
    }));
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toMatch(/capacity/i);
  });

  it("fails closed when the selected Cursor executable is not the release-locked version", () => {
    expect(() => assertCursorAcpVersion("cursor-agent", () => "2026.08.31-4057e58"))
      .toThrow(new RegExp(`expects ${CURSOR_ACP_VERSION}`));
    expect(() => assertCursorAcpVersion("cursor-agent", () => CURSOR_ACP_VERSION)).not.toThrow();
  });

  it("owns Cursor ACP through policy rather than a Cursor-specific runtime", () => {
    expect(existsSync("src/providers/cursorAcpRuntime.ts")).toBe(false);
    expect(existsSync("src/providers/cursorRuntime.ts")).toBe(false);
    expect(existsSync("src/providers/acpRuntime.ts")).toBe(true);
  });
});
