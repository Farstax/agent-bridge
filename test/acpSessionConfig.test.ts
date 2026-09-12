import * as acp from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { runAcpTurn } from "../src/acp/client.js";
import {
  acpProviderDefaultSettingKey,
  acpSessionConfigIntents,
  clearAcpSessionConfigSnapshot,
  getAcpSessionConfigOption,
  hasAcpProviderDefaultIntent,
  planAcpSessionConfig,
  replaceAcpSessionConfigSnapshot,
  setAcpProviderDefaultIntent,
} from "../src/acp/sessionConfig.js";
import { buildModelKeyboard, buildModelsText } from "../src/bridge.js";
import { buildEffortKeyboard, buildEffortText, resolveEffort } from "../src/effort.js";
import { loadBotsConfig } from "../src/config.js";

const configOptions = [
  {
    id: "model-selector",
    name: "Model",
    description: "Choose the session model",
    category: "model",
    type: "select",
    currentValue: "sonnet",
    options: [
      { value: "default", name: "Default", description: "Provider-selected" },
      { value: "sonnet", name: "Sonnet", description: "Fast" },
      { value: "opus", name: "Opus", description: "Deep" },
    ],
  },
  {
    id: "reasoning",
    name: "Reasoning",
    description: "How deeply the agent should reason",
    category: "thought_level",
    type: "select",
    currentValue: "high",
    options: [
      { value: "low", name: "Low", description: "Faster" },
      { value: "high", name: "High", description: "Deeper" },
    ],
  },
] as const;

describe("negotiated ACP session configuration", () => {
  it("selects exact advertised opaque values by semantic category", () => {
    expect(planAcpSessionConfig(configOptions, [
      { category: "model", explicitValue: "opus", preferredValues: ["sonnet"] },
      { category: "thought_level", preferredValues: ["medium", "low"] },
    ])).toEqual({
      selections: [
        { configId: "model-selector", value: "opus", category: "model" },
        { configId: "reasoning", value: "low", category: "thought_level" },
      ],
      stale: [],
    });
  });

  it("treats an advertised literal default as an opaque ACP value", () => {
    expect(planAcpSessionConfig(configOptions, [
      { category: "model", explicitValue: "default", preferredValues: ["opus"] },
    ])).toEqual({
      selections: [{ configId: "model-selector", value: "default", category: "model" }],
      stale: [],
    });
  });

  it("uses provider defaults when no override or matching preference exists", () => {
    expect(planAcpSessionConfig(configOptions, [])).toEqual({ selections: [], stale: [] });
    expect(planAcpSessionConfig(configOptions, [
      { category: "model", preferredValues: ["not-advertised"] },
      { category: "thought_level", preferredValues: ["not-advertised"] },
    ])).toEqual({ selections: [], stale: [] });
    expect(acpSessionConfigIntents("claude", { model: null, effort: null }, {})).toEqual([]);
    expect(acpSessionConfigIntents("codex", { model: null, effort: null }, {})).toEqual([]);
  });

  it("stales unsupported explicit user values and leaves the provider default untouched", () => {
    expect(planAcpSessionConfig(configOptions, [
      { category: "model", explicitValue: "claude-sonnet-5", preferredValues: ["sonnet"] },
    ])).toEqual({
      selections: [],
      stale: [{ category: "model", value: "claude-sonnet-5" }],
    });
  });

  it("fails closed for a required Advisor target instead of translating it", () => {
    expect(() => planAcpSessionConfig(configOptions, [
      { category: "model", explicitValue: "claude-sonnet-5", required: true },
    ])).toThrow(/does not support value/);
  });

  it("keeps explicit provider-default policy out of the ACP value namespace", () => {
    expect(planAcpSessionConfig(configOptions, [
      { category: "model", explicitValue: "default", preferredValues: ["opus"], useProviderDefault: true },
    ])).toEqual({ selections: [], stale: [] });

    setAcpProviderDefaultIntent("claude", "thought_level", true);
    expect(acpSessionConfigIntents("claude", { model: null, effort: null }, {
      CLAUDE_EFFORT: "high",
    })).toEqual([{
      category: "thought_level",
      explicitValue: null,
      preferredValues: [],
      useProviderDefault: true,
    }]);
    setAcpProviderDefaultIntent("claude", "thought_level", false);
  });

  it("degrades gracefully when an agent exposes no matching selector", () => {
    expect(planAcpSessionConfig([], [
      { category: "model", preferredValues: ["opus"] },
    ])).toEqual({ selections: [], stale: [] });
  });

  it("replaces cached config state as one complete ACP snapshot", () => {
    clearAcpSessionConfigSnapshot("claude");
    replaceAcpSessionConfigSnapshot("claude", configOptions);
    expect(getAcpSessionConfigOption("claude", "model")).toMatchObject({
      id: "model-selector",
      currentValue: "sonnet",
      options: expect.arrayContaining([
        { value: "default", name: "Default", description: "Provider-selected" },
        { value: "sonnet", name: "Sonnet", description: "Fast" },
        { value: "opus", name: "Opus", description: "Deep" },
      ]),
    });

    replaceAcpSessionConfigSnapshot("claude", [{
      ...configOptions[0],
      currentValue: "opus",
      options: [{ value: "opus", name: "Opus", description: "Deep" }],
    }]);
    expect(getAcpSessionConfigOption("claude", "model")).toMatchObject({
      currentValue: "opus",
      options: [{ value: "opus", name: "Opus", description: "Deep" }],
    });
    expect(getAcpSessionConfigOption("claude", "thought_level")).toBeNull();
  });

  it("sends the literal default ACP value but sends nothing for Bridge provider-default policy", async () => {
    const calls: Array<[string, string]> = [];
    const agent = acp.agent({ name: "default-collision-fixture" })
      .onRequest(acp.methods.agent.initialize, async () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: { loadSession: false },
      }))
      .onRequest(acp.methods.agent.session.new, async () => ({
        sessionId: "session-default",
        configOptions: [{ ...configOptions[0], currentValue: "opus" }],
      }))
      .onRequest(acp.methods.agent.session.setConfigOption, async (ctx) => {
        calls.push([ctx.params.configId, String(ctx.params.value)]);
        return { configOptions: [{ ...configOptions[0], currentValue: String(ctx.params.value) }] };
      })
      .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
        await ctx.client.notify(acp.methods.client.session.update, {
          sessionId: ctx.params.sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } },
        });
        return { stopReason: "end_turn" };
      });

    await runAcpTurn({
      peer: agent,
      cwd: process.cwd(),
      conversationId: "bridge-default-value",
      runId: "run-default-value",
      existingAcpSessionId: null,
      prompt: "hello",
      executionMode: "safe",
      sessionConfig: [{ category: "model", explicitValue: "default" }],
    });
    expect(calls).toEqual([["model-selector", "default"]]);

    calls.length = 0;
    await runAcpTurn({
      peer: agent,
      cwd: process.cwd(),
      conversationId: "bridge-provider-default",
      runId: "run-provider-default",
      existingAcpSessionId: null,
      prompt: "hello",
      executionMode: "safe",
      sessionConfig: [{ category: "model", useProviderDefault: true }],
    });
    expect(calls).toEqual([]);
  });

  it("replaces dependent config after set_config_option and consumes agent config updates", async () => {
    const calls: Array<[string, string]> = [];
    const fullAfterModel = [
      { ...configOptions[0], currentValue: "opus" },
      {
        ...configOptions[1],
        currentValue: "high",
        options: [
          { value: "high", name: "High", description: "Deeper" },
          { value: "xhigh", name: "Extra high", description: "Deepest" },
        ],
      },
    ];
    const fullAfterReasoning = [
      fullAfterModel[0],
      { ...fullAfterModel[1], currentValue: "xhigh" },
    ];
    const agent = acp.agent({ name: "session-config-fixture" })
      .onRequest(acp.methods.agent.initialize, async () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } },
      }))
      .onRequest(acp.methods.agent.session.new, async () => ({
        sessionId: "session-1",
        configOptions,
      }))
      .onRequest(acp.methods.agent.session.resume, async () => ({
        configOptions: fullAfterReasoning,
      }))
      .onRequest(acp.methods.agent.session.setConfigOption, async (ctx) => {
        calls.push([ctx.params.configId, String(ctx.params.value)]);
        return {
          configOptions: ctx.params.configId === "model-selector" ? fullAfterModel : fullAfterReasoning,
        };
      })
      .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
        await ctx.client.notify(acp.methods.client.session.update, {
          sessionId: ctx.params.sessionId,
          update: {
            sessionUpdate: "config_option_update",
            configOptions: [
              { ...fullAfterReasoning[0], currentValue: "sonnet" },
              fullAfterReasoning[1],
            ],
          } as any,
        });
        await ctx.client.notify(acp.methods.client.session.update, {
          sessionId: ctx.params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "done" },
          },
        });
        return { stopReason: "end_turn" };
      });

    const first = await runAcpTurn({
      peer: agent,
      cwd: process.cwd(),
      conversationId: "bridge-conversation",
      runId: "run-1",
      existingAcpSessionId: null,
      prompt: "hello",
      executionMode: "safe",
      sessionConfig: [
        { category: "model", preferredValues: ["opus"] },
        { category: "thought_level", preferredValues: ["xhigh"] },
      ],
    });
    expect(calls).toEqual([
      ["model-selector", "opus"],
      ["reasoning", "xhigh"],
    ]);
    expect(first.liveText).toBe("done");

    calls.length = 0;
    const resumed = await runAcpTurn({
      peer: agent,
      cwd: process.cwd(),
      conversationId: "bridge-conversation",
      runId: "run-2",
      existingAcpSessionId: first.acpSessionId,
      prompt: "again",
      executionMode: "safe",
    });
    expect(resumed.sessionMode).toBe("resume");
    expect(resumed.acpSessionId).toBe("session-1");
    expect(calls).toEqual([]);
  });
});

describe("ACP Telegram controls", () => {
  it("renders /models from advertised labels/descriptions and keeps literal default selectable", () => {
    replaceAcpSessionConfigSnapshot("claude", configOptions);
    const config = { bots: loadBotsConfig({}) } as any;
    const db = { getSetting: (key: string) => key === "claude" ? "default" : null } as any;

    const text = buildModelsText("claude", { db, config });
    expect(text).toContain("Current: default");
    expect(text).toContain("Default (default): Provider-selected");

    const keyboard = buildModelKeyboard("claude", [], "default", false);
    expect(keyboard.inline_keyboard).toContainEqual([
      { text: "✓ Default", callback_data: "model:claude:default" },
    ]);
    expect(keyboard.inline_keyboard.at(-1)).toEqual([
      { text: "Use provider default", callback_data: "model:claude:reset" },
    ]);
  });

  it("renders provider-controlled state when no model selector is exposed", () => {
    clearAcpSessionConfigSnapshot("codex");
    const config = { bots: loadBotsConfig({}) } as any;
    const db = { getSetting: () => null } as any;
    expect(buildModelsText("codex", { db, config })).toContain("provider-controlled");
  });

  it("renders /effort from advertised thought_level options and honours provider-default reset", () => {
    replaceAcpSessionConfigSnapshot("claude", configOptions);
    setAcpProviderDefaultIntent("claude", "thought_level", true);
    const marker = acpProviderDefaultSettingKey("claude", "thought_level");
    expect(resolveEffort("claude", {
      getSetting: (key: string) => key === marker ? "1" : null,
    } as any, { CLAUDE_EFFORT: "low" } as any)).toBeNull();
    expect(hasAcpProviderDefaultIntent("claude", "thought_level")).toBe(true);
    expect(buildEffortText("claude", null, true)).toContain("provider default (high)");
    expect(buildEffortKeyboard("claude", null, true).inline_keyboard.at(-1)).toEqual([
      { text: "✓ Use provider default", callback_data: "effort:claude:reset" },
    ]);
    setAcpProviderDefaultIntent("claude", "thought_level", false);
  });
});
