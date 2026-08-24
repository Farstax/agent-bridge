import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCliInvocation, parseCliResult } from "../src/cli.js";
import { loadBotsConfig, resolveExecutionMode } from "../src/config.js";
import { openDb } from "../src/db.js";
import { getProviderAdapter, PROVIDER_IDS, resolveProviderExecutable, supportsToolFreeMode } from "../src/providers/registry.js";
import { interactiveChainKinds, parseCliChain } from "../src/providers/selection.js";
import { resolveSkillPaths, CURSOR_SKILL_DISCOVERY_NOTE } from "../src/skills.js";

function cursorJson(result: Record<string, unknown>): string {
  return `${JSON.stringify(result)}\n`;
}

function cursorStream(events: unknown[]): string {
  return events.map((event) => JSON.stringify(event)).join("\n") + "\n";
}

describe("cursor provider registration", () => {
  it("registers cursor as an interactive fallback provider with toolFree false", () => {
    expect(PROVIDER_IDS).toContain("cursor");
    const adapter = getProviderAdapter("cursor");
    expect(adapter.displayName).toBe("Cursor");
    expect(adapter.executable).toBe("cursor-agent");
    expect(adapter.capabilities.interactive).toBe(true);
    expect(adapter.capabilities.fallbackTarget).toBe(true);
    expect(adapter.capabilities.toolFree).toBe(false);
    expect(supportsToolFreeMode("cursor")).toBe(false);
  });

  it("resolves CURSOR_COMMAND and CURSOR_MODEL_PREFERENCE through bot config", () => {
    expect(resolveProviderExecutable("cursor", {})).toBe("cursor-agent");
    expect(resolveProviderExecutable("cursor", { CURSOR_COMMAND: "/opt/cursor/cursor-agent" })).toBe("/opt/cursor/cursor-agent");
    expect(loadBotsConfig({}).cursor.command).toBe("cursor-agent");
    expect(loadBotsConfig({ CURSOR_COMMAND: "/usr/local/bin/cursor-agent" }).cursor.command).toBe("/usr/local/bin/cursor-agent");
    expect(loadBotsConfig({ CURSOR_MODEL_PREFERENCE: "composer-2.5,auto" }).cursor.modelPreference).toEqual([
      "composer-2.5",
      "auto",
    ]);
  });

  it("stays opt-in and is absent from the production default interactive fallback", () => {
    expect(interactiveChainKinds()).toContain("cursor");
    const productionDefault = ["codex", "claude", "grok", "antigravity"] as const;
    expect(productionDefault).not.toContain("cursor");
    expect(parseCliChain(undefined, {
      allowed: interactiveChainKinds(),
      fallback: productionDefault,
    })).toEqual(["codex", "claude", "grok", "antigravity"]);
  });

  it("is selectable only through an explicit chain override", () => {
    expect(parseCliChain("cursor", {
      allowed: interactiveChainKinds(),
      fallback: ["codex", "claude", "grok", "antigravity"],
    })).toEqual(["cursor"]);
    expect(parseCliChain("codex,cursor", {
      allowed: interactiveChainKinds(),
      fallback: ["codex", "claude", "grok", "antigravity"],
    })).toEqual(["codex", "cursor"]);
  });

  it("uses shared safe|trusted execution-mode resolution", () => {
    expect(resolveExecutionMode("cursor", {})).toBe("safe");
    expect(resolveExecutionMode("cursor", { CURSOR_EXECUTION_MODE: "trusted" })).toBe("trusted");
    expect(resolveExecutionMode("cursor", { CURSOR_EXECUTION_MODE: "safe", BRIDGE_EXECUTION_MODE: "trusted" })).toBe("safe");
  });
});

describe("cursor invocation", () => {
  it("builds a fresh headless json invocation with the qualified cursor-agent contract", () => {
    const invocation = buildCliInvocation({
      bot: "cursor",
      prompt: "hello",
      sessionId: null,
      command: "/opt/cursor/cursor-agent",
      includeResponseContract: false,
    });
    expect(invocation.command).toBe("/opt/cursor/cursor-agent");
    expect(invocation.nativeSessionMode).toBe("fresh");
    expect(invocation.args[0]).toBe("-p");
    expect(invocation.args[1]).toContain("hello");
    expect(invocation.args.slice(2)).toEqual(["--output-format", "json"]);
  });

  it("resumes with the exact qualified --resume <session-id> syntax", () => {
    const invocation = buildCliInvocation({
      bot: "cursor",
      prompt: "continue",
      sessionId: "sess-abc",
      command: "cursor-agent",
      includeResponseContract: false,
    });
    expect(invocation.nativeSessionMode).toBe("resume");
    expect(invocation.args.slice(2)).toEqual([
      "--output-format", "json",
      "--resume", "sess-abc",
    ]);
  });

  it("maps trusted execution to the qualified trust flags without requiring host sandbox", () => {
    const invocation = buildCliInvocation({
      bot: "cursor",
      prompt: "edit files",
      sessionId: null,
      command: "cursor-agent",
      model: "composer-2.5",
      executionMode: "trusted",
      includeResponseContract: false,
    });
    expect(invocation.args.slice(2)).toEqual([
      "--output-format", "json",
      "--model", "composer-2.5",
      "--trust",
      "--sandbox", "disabled",
    ]);
  });

  it("can request stream-json when the shared outputFormat asks for it", () => {
    const invocation = buildCliInvocation({
      bot: "cursor",
      prompt: "stream",
      sessionId: null,
      command: "cursor-agent",
      outputFormat: "stream-json",
      includeResponseContract: false,
    });
    expect(invocation.args.slice(2)).toEqual(["--output-format", "stream-json"]);
  });

  it("rejects tool-free mode", () => {
    expect(() => buildCliInvocation({
      bot: "cursor",
      prompt: "hi",
      sessionId: null,
      command: "cursor-agent",
      toolMode: "none",
    })).toThrow(/Tool-free mode is not supported for cursor/);
  });

  it("rejects attachments until separately qualified", () => {
    expect(() => buildCliInvocation({
      bot: "cursor",
      prompt: "describe this",
      sessionId: null,
      command: "cursor-agent",
      attachments: ["/tmp/image.png"],
      includeResponseContract: false,
    })).toThrow(/does not support attachment invocation/i);
  });
});

describe("cursor result parsing", () => {
  it("parses a successful json terminal result and session id", () => {
    const result = parseCliResult({
      bot: "cursor",
      stdout: cursorJson({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "MARKER_A",
        session_id: "sess-1",
      }),
    });
    expect(result.text).toBe("MARKER_A");
    expect(result.sessionId).toBe("sess-1");
  });

  it("selects the terminal stream-json result event", () => {
    const result = parseCliResult({
      bot: "cursor",
      stdout: cursorStream([
        { type: "system", subtype: "init", session_id: "sess-2" },
        { type: "user", message: { role: "user", content: [{ type: "text", text: "hi" }] }, session_id: "sess-2" },
        { type: "thinking", session_id: "sess-2" },
        { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "partial" }] }, session_id: "sess-2" },
        { type: "result", subtype: "success", is_error: false, result: "MARKER_C", session_id: "sess-2" },
      ]),
    });
    expect(result.text).toBe("MARKER_C");
    expect(result.sessionId).toBe("sess-2");
  });

  it("fails closed on malformed structured output", () => {
    expect(() => parseCliResult({ bot: "cursor", stdout: "{not-json\n" })).toThrow(/malformed|Cursor/i);
  });

  it("fails closed when the terminal result is an error", () => {
    expect(() => parseCliResult({
      bot: "cursor",
      stdout: cursorJson({
        type: "result",
        subtype: "error",
        is_error: true,
        result: "boom",
        session_id: "sess-3",
      }),
    })).toThrow(/Cursor/i);
  });

  it("leaves nonzero CLI failures diagnosable when stdout has no JSON", () => {
    expect(() => parseCliResult({
      bot: "cursor",
      stdout: "",
    })).toThrow(/terminal|session|result|Cursor/i);
  });
});

describe("cursor skill projection", () => {
  it("uses one canonical Cursor-native skill directory and documents cross-CLI ambiguity", () => {
    const home = mkdtempSync(join(tmpdir(), "cursor-skills-"));
    const paths = resolveSkillPaths(home);
    expect(paths.cursorSkillsDir).toBe(join(home, ".cursor", "skills"));
    expect(CURSOR_SKILL_DISCOVERY_NOTE).toMatch(/claude/i);
    expect(CURSOR_SKILL_DISCOVERY_NOTE).toMatch(/\.cursor\/skills/i);
  });
});

describe("cursor session persistence", () => {
  it("stores and reloads native Cursor session ids through the shared session repository", () => {
    const db = openDb(":memory:");
    expect(db.getSession("chat:cursor", "cursor")).toBeNull();
    db.setSession("chat:cursor", "cursor", "sess-durable");
    expect(db.getSession("chat:cursor", "cursor")).toBe("sess-durable");
    db.setSession("chat:cursor", "cursor", null);
    expect(db.getSession("chat:cursor", "cursor")).toBeNull();
  });

  it("includes Cursor consecutive failures in the health circuit-breaker aggregate", () => {
    const db = openDb(":memory:");
    db.incrementFailures("chat:cursor", "cursor");
    db.incrementFailures("chat:cursor", "cursor");
    expect(db.getMaxConsecutiveFailures()).toEqual([{ bot: "cursor", count: 2 }]);
    db.resetFailures("chat:cursor", "cursor");
    expect(db.getMaxConsecutiveFailures()).toEqual([]);
  });
});
