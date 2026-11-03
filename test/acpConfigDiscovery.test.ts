import { afterEach, describe, expect, it } from "vitest";
import { runAcpSessionSetup } from "../src/acp/index.js";
import {
  clearAcpSessionConfigSnapshot,
  replaceAcpSessionConfigSnapshot,
  type AcpSessionConfigOptionSnapshot,
} from "../src/acp/sessionConfig.js";
import { openDb } from "../src/db.js";
import { resolveExecutionMode } from "../src/config.js";
import { prepareInteractiveAcpConfigControl } from "../src/interactiveAcpConfig.js";
import { lookupProviderSession, persistProviderSession } from "../src/providers/sessionRuntime.js";
import { createFakeAcpAgent } from "./support/fakeAcpAgent.js";

const modelOptions: readonly AcpSessionConfigOptionSnapshot[] = [{
  id: "model",
  category: "model",
  type: "select",
  currentValue: "provider-default",
  options: [{ value: "provider-default", name: "Provider default" }],
}];

const effortOptions: readonly AcpSessionConfigOptionSnapshot[] = [{
  id: "effort",
  category: "thought_level",
  type: "select",
  currentValue: "medium",
  options: [{ value: "medium", name: "Medium" }],
}];

afterEach(() => {
  clearAcpSessionConfigSnapshot("codex");
});

describe("ACP config discovery", () => {
  it("negotiates session configuration without dispatching a prompt", async () => {
    const result = await runAcpSessionSetup({
      peer: createFakeAcpAgent({ loadSession: true, close: true }),
      cwd: process.cwd(),
      conversationId: "config-control:codex:chat-1",
      runId: "config-control-run-1",
      existingAcpSessionId: null,
      executionMode: "safe",
    });

    expect(result.sessionMode).toBe("fresh");
    expect(result.acpSessionId).toMatch(/^acp-/);
    expect(result.liveText).toBe("");
    expect(result.events).toEqual([]);
    expect(result.updates).toEqual([]);
    expect(result.configOptions.some((option) => option.id === "effort")).toBe(true);
    expect(result.usage).toBeUndefined();
  });

  it("does not turn a config-only fresh session into the conversation session", async () => {
    const db = openDb(":memory:");
    try {
      await prepareInteractiveAcpConfigControl({
        kind: "codex",
        commandText: "/models",
        surfaceIdentity: "telegram:interactive",
        chatKey: "chat-fresh",
        db,
        executionMode: "safe",
        discover: async (input) => {
          expect(input.existingAcpSessionId).toBeNull();
          replaceAcpSessionConfigSnapshot("codex", modelOptions, []);
          return { sessionId: "config-only-session", configOptions: modelOptions };
        },
      });

      expect(lookupProviderSession(db, { surfaceIdentity: "telegram:interactive", chatKey: "chat-fresh" }, "codex")).toBeNull();
    } finally {
      db.close();
    }
  });

  it("reuses provider execution mode and authorised Workstream cwd for outward config discovery", async () => {
    const db = openDb(":memory:");
    try {
      const executionMode = resolveExecutionMode("codex", {
        BRIDGE_EXECUTION_MODE: "safe",
        CODEX_EXECUTION_MODE: "trusted",
      });
      expect(executionMode).toBe("trusted");
      const received: Array<{ cwd: string; executionMode: string; conversationId: string; existingAcpSessionId: string | null }> = [];
      await prepareInteractiveAcpConfigControl({
        kind: "codex",
        commandText: "/models",
        surfaceIdentity: "acp:outward",
        chatKey: "acp:workstream-1",
        db,
        cwd: "/apps/workstream-1",
        executionMode,
        discover: async (input) => {
          received.push(input);
          replaceAcpSessionConfigSnapshot("codex", modelOptions, []);
          return { sessionId: "transient-catalogue-only", configOptions: modelOptions };
        },
      });

      expect(received).toEqual([expect.objectContaining({
        cwd: "/apps/workstream-1",
        executionMode: "trusted",
        conversationId: "acp:workstream-1",
        existingAcpSessionId: null,
      })]);
      expect(lookupProviderSession(db, { surfaceIdentity: "acp:outward", chatKey: "acp:workstream-1" }, "codex")).toBeNull();
    } finally {
      db.close();
    }
  });

  it("falls back to a transient fresh probe when resume does not advertise the requested category", async () => {
    const db = openDb(":memory:");
    try {
      persistProviderSession(db, { surfaceIdentity: "telegram:interactive", chatKey: "chat-resume" }, "codex", "conversation-session");
      const attempts: Array<string | null> = [];

      await prepareInteractiveAcpConfigControl({
        kind: "codex",
        commandText: "/models",
        surfaceIdentity: "telegram:interactive",
        chatKey: "chat-resume",
        db,
        executionMode: "safe",
        discover: async (input) => {
          attempts.push(input.existingAcpSessionId);
          if (input.existingAcpSessionId) {
            replaceAcpSessionConfigSnapshot("codex", effortOptions, []);
            return { sessionId: input.existingAcpSessionId, configOptions: effortOptions };
          }
          replaceAcpSessionConfigSnapshot("codex", modelOptions, []);
          return { sessionId: "transient-config-session", configOptions: modelOptions };
        },
      });

      expect(attempts).toEqual(["conversation-session", null]);
      expect(lookupProviderSession(db, { surfaceIdentity: "telegram:interactive", chatKey: "chat-resume" }, "codex")).toBe("conversation-session");
    } finally {
      db.close();
    }
  });
});