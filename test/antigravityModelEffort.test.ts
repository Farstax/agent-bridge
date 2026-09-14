import { describe, expect, it } from "vitest";
import {
  appendEffortArgs,
  resolveAgyModelForEffort,
} from "../src/effort.js";
import {
  DEFAULT_ANTIGRAVITY_MODEL_PREFERENCE,
  loadBotsConfig,
  parseAntigravityModelPreference,
} from "../src/config.js";
import { buildCliInvocation, getNextFallbackModel } from "../src/cli.js";
import { agyAcpPolicy } from "../src/providers/agyAcpPolicy.js";
import { openDb } from "../src/db.js";
import type { ProviderInvocationRequest } from "../src/providers/types.js";

describe("Antigravity model families and effort", () => {
  it("keeps BotConfig.modelPreference empty because ACP session config owns the catalogue", () => {
    expect(loadBotsConfig({}).antigravity.modelPreference).toEqual([]);
    expect(DEFAULT_ANTIGRAVITY_MODEL_PREFERENCE[0]).toBe("gemini-3.8-flash");
  });

  it("normalizes qualified legacy effort triads without rewriting unknown model ids", () => {
    expect(parseAntigravityModelPreference([
      "gemini-3.8-flash-high",
      "gemini-3.8-flash-medium",
      "gemini-3.8-flash-low",
      "gemini-3.7-flash-high",
      "gemini-future-preview-high",
      "claude-sonnet-4-6",
    ].join(","))).toEqual([
      "gemini-3.8-flash",
      "gemini-3.7-flash",
      "gemini-future-preview-high",
      "claude-sonnet-4-6",
    ]);
  });

  it("normalizes legacy persisted model overrides so family fallback still advances", () => {
    const db = openDb(":memory:");
    try {
      db.setSetting("antigravity", "gemini-3.8-flash-high");
      const current = db.getSetting("antigravity");
      expect(current).toBe("gemini-3.8-flash");
      expect(getNextFallbackModel(current, [...DEFAULT_ANTIGRAVITY_MODEL_PREFERENCE])).toBe("gemini-3.7-flash");

      db.setSetting("antigravity", "gemini-future-preview-high");
      expect(db.getSetting("antigravity")).toBe("gemini-future-preview-high");
    } finally {
      db.close();
    }
  });

  it("maps bridge effort to concrete qualified Gemini Agy variants", () => {
    expect(resolveAgyModelForEffort("gemini-3.8-flash", "low")).toBe("gemini-3.8-flash-low");
    expect(resolveAgyModelForEffort("gemini-3.8-flash", "medium")).toBe("gemini-3.8-flash-medium");
    expect(resolveAgyModelForEffort("gemini-3.8-flash", "high")).toBe("gemini-3.8-flash-high");
    expect(resolveAgyModelForEffort("gemini-3.8-flash-medium", "high")).toBe("gemini-3.8-flash-high");
    expect(resolveAgyModelForEffort("gemini-3.8-flash", "xhigh")).toBe("gemini-3.8-flash-high");
    expect(resolveAgyModelForEffort("gemini-3.8-flash", "max")).toBe("gemini-3.8-flash-high");
    expect(resolveAgyModelForEffort("gemini-3.8-flash-high", null)).toBe("gemini-3.8-flash-high");
  });

  it("preserves unqualified Agy models and maps the qualified 3.1 Pro capability", () => {
    expect(resolveAgyModelForEffort("claude-sonnet-4-6", "high")).toBe("claude-sonnet-4-6");
    expect(resolveAgyModelForEffort("gemini-future-preview", "high")).toBe("gemini-future-preview");
    expect(resolveAgyModelForEffort("gemini-future-preview-high", "low")).toBe("gemini-future-preview-high");
    expect(resolveAgyModelForEffort("gemini-3.1-pro", "low")).toBe("gemini-3.1-pro-low");
    expect(resolveAgyModelForEffort("gemini-3.1-pro", "medium")).toBe("gemini-3.1-pro-high");
  });

  it("keeps Agy effort out of ACP argv and expresses it as session config", () => {
    const args = ["--uid="];
    expect(appendEffortArgs("agy_acp_server.par", args, "high")).toBe(args);
    const invocation = buildCliInvocation({
      bot: "antigravity",
      prompt: "hi",
      sessionId: null,
      command: "agy_acp_server.par",
      model: "gemini-3.8-flash",
      effort: "high",
    });
    expect(invocation.transport).toBe("acp-stdio");
    expect(invocation.args).toEqual(["--uid="]);
    const request: ProviderInvocationRequest = {
      prompt: "hi",
      sessionId: null,
      command: "agy_acp_server.par",
      model: "gemini-3.8-flash",
      executionMode: "safe",
      outputFormat: "json",
      soulContext: null,
      attachments: [],
      outputDir: null,
      effort: "high",
      toolMode: "default",
    };
    expect(agyAcpPolicy.sessionSettings?.(request, {})?.config).toEqual([
      { category: "model", explicitValue: "gemini-3.8-flash", preferredValues: [] },
      { category: "thought_level", explicitValue: "high", preferredValues: [] },
    ]);
  });
});
