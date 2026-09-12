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
    expect(claudeAcpPolicy.sessionSettings?.(request({ executionMode: "safe" }), {})).toMatchObject({
      modeId: "default",
      meta: {
        systemPrompt: { append: expect.any(String) },
        claudeCode: { options: { settingSources: [] } },
      },
    });
    expect(claudeAcpPolicy.sessionSettings?.(request({ executionMode: "trusted" }), {})).toMatchObject({
      modeId: "default",
      meta: {
        systemPrompt: { append: expect.any(String) },
        claudeCode: { options: { settingSources: [] } },
      },
    });
  });

  it("expresses model and effort as semantic ACP intents without provider-id translation", () => {
    expect(claudeAcpPolicy.sessionSettings?.(request({
      model: null,
      effort: "xhigh",
      toolMode: "none",
    }), {
      CLAUDE_MODEL_PREFERENCE: "sonnet,opus",
      CLAUDE_EFFORT: "xhigh",
    })).toEqual({
      modeId: "default",
      config: [
        { category: "model", explicitValue: null, preferredValues: ["sonnet", "opus"] },
        { category: "thought_level", explicitValue: "xhigh", preferredValues: ["xhigh"] },
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
    expect(claudeAcpPolicy.sessionSettings?.(request({ model: "sonnet" }), {})?.config).toEqual([
      { category: "model", explicitValue: "sonnet", preferredValues: [] },
    ]);
    expect(claudeAcpPolicy.sessionSettings?.(request({ model: "claude-sonnet-5" }), {})?.config).toEqual([
      { category: "model", explicitValue: "claude-sonnet-5", preferredValues: [] },
    ]);
    expect(claudeAcpPolicy.sessionSettings?.(request(), {}).meta).toEqual({
      systemPrompt: { append: expect.any(String) },
      claudeCode: { options: { settingSources: [] } },
    });
    expect(supportsToolFreeMode("claude")).toBe(true);
  });

  it("negotiates opaque config ids/values and re-reads reasoning choices after model change", async () => {
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
              id: "model-selector",
              name: "Model",
              category: "model",
              type: "select",
              currentValue: "claude-a",
              options: [
                { value: "claude-a", name: "Claude A" },
                { value: "claude-b", name: "Claude B" },
              ],
            },
            {
              id: "reasoning",
              name: "Effort",
              category: "thought_level",
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
        if (ctx.params.configId === "model-selector") {
          return {
            configOptions: [
              {
                id: "model-selector",
                name: "Model",
                category: "model",
                type: "select",
                currentValue: ctx.params.value,
                options: [
                  { value: "claude-a", name: "Claude A" },
                  { value: "claude-b", name: "Claude B" },
                ],
              },
              {
                id: "reasoning",
                name: "Effort",
                category: "thought_level",
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
        return {
          configOptions: [
            {
              id: "model-selector",
              name: "Model",
              category: "model",
              type: "select",
              currentValue: "claude-b",
              options: [
                { value: "claude-a", name: "Claude A" },
                { value: "claude-b", name: "Claude B" },
              ],
            },
            {
              id: "reasoning",
              name: "Effort",
              category: "thought_level",
              type: "select",
              currentValue: ctx.params.value,
              options: [
                { value: "high", name: "High" },
                { value: "xhigh", name: "Extra high" },
              ],
            },
          ],
        };
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
    }), {});
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
    expect(calls.map((call) => call.kind)).toEqual(["new-meta", "mode", "model-selector", "reasoning"]);
    expect(calls[0]?.value).toEqual(expect.objectContaining({
      disableBuiltInTools: true,
      claudeCode: { options: expect.objectContaining({ settingSources: [] }) },
    }));
    expect(calls.slice(1)).toEqual([
      { kind: "mode", value: "default" },
      { kind: "model-selector", value: "claude-b" },
      { kind: "reasoning", value: "xhigh" },
    ]);
    expect(result.configOptions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "model-selector", currentValue: "claude-b" }),
      expect.objectContaining({ id: "reasoning", currentValue: "xhigh" }),
    ]));
  });

  it("fails closed instead of silently ignoring an unadvertised exact config value", async () => {
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
          category: "model",
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
