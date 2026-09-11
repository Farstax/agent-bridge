import * as acp from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { buildCliInvocation } from "../src/cli.js";
import { runAcpTurn } from "../src/acp/client.js";
import { getLockedAcpRegistryEntry } from "../src/providers/acpRegistry.js";
import { resolveProviderRuntime } from "../src/providers/acpRuntime.js";
import { claudeAcpPolicy } from "../src/providers/claudeAcpPolicy.js";
import { getAcpProviderPolicy, supportsToolFreeMode } from "../src/providers/registry.js";
import type { ProviderInvocationRequest } from "../src/providers/types.js";

function request(overrides: Partial<ProviderInvocationRequest> = {}): ProviderInvocationRequest {
  return {
    prompt: "hello",
    sessionId: null,
    command: "claude",
    model: null,
    executionMode: "safe",
    outputFormat: "stream-json",
    soulContext: null,
    attachments: [],
    outputDir: null,
    effort: null,
    toolMode: "default",
    ...overrides,
  };
}

describe("Claude ACP provider", () => {
  it("locks the official Registry distribution and selects it for execution", () => {
    expect(getLockedAcpRegistryEntry("claude")).toEqual(expect.objectContaining({
      id: "claude-acp",
      version: "0.76.0",
      distribution: {
        npx: { package: "@agentclientprotocol/claude-agent-acp@0.76.0" },
      },
    }));
    expect(getAcpProviderPolicy("claude")).toBe(claudeAcpPolicy);
    expect(resolveProviderRuntime("claude", { BRIDGE_CURRENT_RELEASE_DIR: "/opt/agent-bridge" })).toEqual(expect.objectContaining({
      providerId: "claude",
      transport: "acp-stdio",
      executable: "/opt/agent-bridge/node_modules/.bin/claude-agent-acp",
      args: [],
      versionArgs: ["--version"],
      runtimeIdentity: expect.stringMatching(/^acp:claude-acp@0\.76\.0:[a-f0-9]{64}$/),
      toolFree: true,
      provisionalAnswers: true,
    }));

    const invocation = buildCliInvocation({
      bot: "claude",
      prompt: "hello",
      sessionId: null,
      command: "claude",
      model: null,
    });
    expect(invocation).toEqual({
      command: expect.stringMatching(/node_modules\/\.bin\/claude-agent-acp$/),
      args: [],
      nativeSessionMode: "fresh",
      prompt: "hello",
      transport: "acp-stdio",
    });
  });

  it("keeps Bridge permission authority in Claude manual mode for safe and trusted Runs", () => {
    expect(claudeAcpPolicy.sessionSettings?.(request({ executionMode: "safe" }))).toMatchObject({
      modeId: "default",
      meta: { claudeCode: { options: { settingSources: [] } } },
    });
    expect(claudeAcpPolicy.sessionSettings?.(request({ executionMode: "trusted" }))).toMatchObject({
      modeId: "default",
      meta: { claudeCode: { options: { settingSources: [] } } },
    });
  });

  it("maps model and effort through standard ACP config and enables only proven strict tool-free metadata", () => {
    expect(claudeAcpPolicy.sessionSettings?.(request({
      model: "claude-sonnet-4-5",
      effort: "xhigh",
      toolMode: "none",
    }))).toEqual({
      modeId: "default",
      config: [
        { configId: "model", value: "claude-sonnet-4-5" },
        { configId: "effort", value: "xhigh" },
      ],
      meta: {
        disableBuiltInTools: true,
        claudeCode: {
          options: {
            tools: [],
            mcpServers: {},
            strictMcpConfig: true,
            settingSources: [],
          },
        },
      },
    });
    expect(claudeAcpPolicy.sessionSettings?.(request()).meta).toEqual({
      claudeCode: { options: { settingSources: [] } },
    });
    expect(supportsToolFreeMode("claude")).toBe(true);
  });

  it("negotiates mode/config, forwards session metadata, and re-reads effort choices after model change", async () => {
    const calls: Array<{ kind: string; value: unknown }> = [];
    const sessions = new Set<string>();
    const agent = acp.agent({ name: "claude-policy-fixture" })
      .onRequest(acp.methods.agent.initialize, async () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } },
      }))
      .onRequest(acp.methods.agent.session.new, async (ctx) => {
        calls.push({ kind: "new-meta", value: ctx.params._meta });
        sessions.add("claude-session");
        return {
          sessionId: "claude-session",
          modes: {
            currentModeId: "plan",
            availableModes: [
              { id: "default", name: "Manual" },
              { id: "plan", name: "Plan" },
            ],
          },
          configOptions: [
            {
              id: "model",
              name: "Model",
              type: "select",
              currentValue: "claude-a",
              options: [
                { value: "claude-a", name: "Claude A" },
                { value: "claude-b", name: "Claude B" },
              ],
            },
            {
              id: "effort",
              name: "Effort",
              type: "select",
              currentValue: "low",
              options: [{ value: "low", name: "Low" }],
            },
          ],
        };
      })
      .onRequest(acp.methods.agent.session.setMode, async (ctx) => {
        calls.push({ kind: "mode", value: ctx.params.modeId });
        return {};
      })
      .onRequest(acp.methods.agent.session.setConfigOption, async (ctx) => {
        calls.push({ kind: ctx.params.configId, value: ctx.params.value });
        if (ctx.params.configId === "model") {
          return {
            configOptions: [
              {
                id: "model",
                name: "Model",
                type: "select",
                currentValue: ctx.params.value,
                options: [
                  { value: "claude-a", name: "Claude A" },
                  { value: "claude-b", name: "Claude B" },
                ],
              },
              {
                id: "effort",
                name: "Effort",
                type: "select",
                currentValue: "high",
                options: [
                  { value: "high", name: "High" },
                  { value: "xhigh", name: "Extra high" },
                ],
              },
            ],
          };
        }
        return { configOptions: [] };
      })
      .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
        expect(sessions.has(ctx.params.sessionId)).toBe(true);
        await ctx.client.notify(acp.methods.client.session.update, {
          sessionId: ctx.params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "configured" },
          },
        });
        return { stopReason: "end_turn" };
      });

    const settings = claudeAcpPolicy.sessionSettings?.(request({
      model: "claude-b",
      effort: "xhigh",
      toolMode: "none",
    }));
    const result = await runAcpTurn({
      peer: agent,
      cwd: process.cwd(),
      conversationId: "bridge-conversation",
      runId: "run-1",
      existingAcpSessionId: null,
      prompt: "hello",
      executionMode: "trusted",
      sessionMeta: settings?.meta,
      sessionModeId: settings?.modeId,
      sessionConfig: settings?.config,
    });

    expect(result.liveText).toBe("configured");
    expect(calls.map((call) => call.kind)).toEqual(["new-meta", "mode", "model", "effort"]);
    expect(calls[0]?.value).toEqual(expect.objectContaining({ disableBuiltInTools: true }));
    expect(calls.slice(1)).toEqual([
      { kind: "mode", value: "default" },
      { kind: "model", value: "claude-b" },
      { kind: "effort", value: "xhigh" },
    ]);
  });

  it("fails closed instead of silently ignoring an unadvertised requested config value", async () => {
    const agent = acp.agent({ name: "config-fixture" })
      .onRequest(acp.methods.agent.initialize, async () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: { loadSession: false },
      }))
      .onRequest(acp.methods.agent.session.new, async () => ({
        sessionId: "session",
        modes: {
          currentModeId: "default",
          availableModes: [{ id: "default", name: "Manual" }],
        },
        configOptions: [{
          id: "model",
          name: "Model",
          type: "select",
          currentValue: "claude-a",
          options: [{ value: "claude-a", name: "Claude A" }],
        }],
      }));

    await expect(runAcpTurn({
      peer: agent,
      cwd: process.cwd(),
      conversationId: "bridge-conversation",
      runId: "run-invalid",
      existingAcpSessionId: null,
      prompt: "hello",
      executionMode: "safe",
      sessionModeId: "default",
      sessionConfig: [{ configId: "model", value: "not-advertised" }],
    })).rejects.toThrow(/does not support value/);
  });
});
