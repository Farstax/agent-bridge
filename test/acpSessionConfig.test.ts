import { describe, expect, it } from "vitest";
import {
  ACP_PROVIDER_DEFAULT,
  clearAcpSessionConfigSnapshot,
  getAcpSessionConfigOption,
  planAcpSessionConfig,
  replaceAcpSessionConfigSnapshot,
} from "../src/acp/sessionConfig.js";

const configOptions = [
  {
    id: "model-selector",
    name: "Model",
    description: "Choose the session model",
    category: "model",
    type: "select",
    currentValue: "sonnet",
    options: [
      { value: "sonnet", name: "Sonnet", description: "Fast" },
      { value: "opus", name: "Opus", description: "Deep" },
    ],
  },
  {
    id: "reasoning",
    name: "Reasoning",
    category: "thought_level",
    type: "select",
    currentValue: "high",
    options: [
      { value: "low", name: "Low" },
      { value: "high", name: "High" },
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

  it("stales unsupported explicit values and leaves the provider default untouched", () => {
    expect(planAcpSessionConfig(configOptions, [
      { category: "model", explicitValue: "claude-sonnet-5", preferredValues: ["sonnet"] },
    ])).toEqual({
      selections: [],
      stale: [{ category: "model", value: "claude-sonnet-5" }],
    });
  });

  it("lets an explicit provider-default choice suppress operator preferences", () => {
    expect(planAcpSessionConfig(configOptions, [
      { category: "model", explicitValue: ACP_PROVIDER_DEFAULT, preferredValues: ["opus"] },
    ])).toEqual({ selections: [], stale: [] });
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
      options: [
        { value: "sonnet", name: "Sonnet", description: "Fast" },
        { value: "opus", name: "Opus", description: "Deep" },
      ],
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
});
