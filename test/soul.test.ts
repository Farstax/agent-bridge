import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCliInvocation } from "../src/cli.js";
import { wrapPromptContext } from "../src/promptWrapping.js";
import { defaultSoulPath, loadSoulContext, renderSoulContract } from "../src/soul.js";

const tempDirs: string[] = [];

function tempSoulFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-bridge-soul-"));
  tempDirs.push(dir);
  const path = join(dir, "SOUL.md");
  writeFileSync(path, content, "utf8");
  return path;
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("SOUL.md runtime context", () => {
  it("resolves the default SOUL.md path from the bridge project directory", () => {
    expect(defaultSoulPath("agent-bridge")).toBe(join("agent-bridge", "SOUL.md"));
  });

  it("returns null when mode is off, file is missing, or content is whitespace only", () => {
    expect(loadSoulContext({ mode: "off", path: "/does/not/exist" })).toBeNull();
    expect(loadSoulContext({ mode: "summary", path: "/does/not/exist" })).toBeNull();
    const emptyPath = tempSoulFile("   \n\t  \n");
    expect(loadSoulContext({ mode: "summary", path: emptyPath })).toBeNull();
  });

  it("loads arbitrary plain Markdown without requiring prescribed headings or sections", () => {
    const arbitraryMarkdown = [
      "# My Custom Agent",
      "",
      "You are a thoughtful pair programmer who loves simplicity.",
      "- Speak plainly without jargon.",
      "- Always consider edge cases first.",
    ].join("\n");
    const path = tempSoulFile(arbitraryMarkdown);

    const context = loadSoulContext({ mode: "summary", path });
    expect(context).toBe(arbitraryMarkdown);
  });

  it("preserves author's exact heading order without reordering or schema enforcement", () => {
    const customContent = [
      "## Quirks",
      "Prefers spaces over tabs.",
      "",
      "## Identity",
      "Custom Identity here.",
    ].join("\n");
    const path = tempSoulFile(customContent);

    const context = loadSoulContext({ mode: "summary", path });
    expect(context).toBe(customContent);
    expect(context!.indexOf("Quirks")).toBeLessThan(context!.indexOf("Identity"));
  });

  it("caps oversized SOUL.md content in summary and full modes", () => {
    const oversized = `Some intro text.\n${"x".repeat(20_000)}`;
    const path = tempSoulFile(oversized);

    const summaryContext = loadSoulContext({ mode: "summary", path });
    expect(summaryContext).not.toBeNull();
    expect(summaryContext!.length).toBeLessThanOrEqual(4_000);
    expect(summaryContext).toContain("[truncated]");

    const fullContext = loadSoulContext({ mode: "full", path });
    expect(fullContext).not.toBeNull();
    expect(fullContext!.length).toBeLessThanOrEqual(12_000);
    expect(fullContext).toContain("[truncated]");

    const customContext = loadSoulContext({ mode: "summary", path, maxChars: 500 });
    expect(customContext).not.toBeNull();
    expect(customContext!.length).toBeLessThanOrEqual(500);
    expect(customContext).toContain("[truncated]");
  });

  it("renders Soul contract with explicit safety precedence notice", () => {
    const rendered = renderSoulContract("You are an assistant.");
    expect(rendered).toContain("Soul contract:\nYou are an assistant.");
    expect(rendered).toContain("Higher-priority bridge/system/developer instructions always win.");

    // Does not duplicate notice if already present
    const renderedAgain = renderSoulContract("You are an assistant.\n\nHigher-priority bridge/system/developer instructions always win.");
    const occurrences = renderedAgain!.split("Higher-priority bridge/system/developer instructions always win.").length - 1;
    expect(occurrences).toBe(1);
  });

  it("returns null when rendering null or empty soul contract", () => {
    expect(renderSoulContract(null)).toBeNull();
    expect(renderSoulContract("   ")).toBeNull();
  });

  it("injects arbitrary plain Markdown provider-neutrally across supported providers", () => {
    const arbitrarySoul = "You are a versatile pair programmer.\nPrefers explicit types.";
    const soulContext = loadSoulContext({ mode: "summary", path: tempSoulFile(arbitrarySoul) });
    expect(soulContext).toBe(arbitrarySoul);

    const wrapped = wrapPromptContext("implement this feature", soulContext, true);
    expect(wrapped).toContain("Soul contract:\nYou are a versatile pair programmer.\nPrefers explicit types.");
    expect(wrapped).toContain("Higher-priority bridge/system/developer instructions always win.");
    expect(wrapped).toContain("Agent Bridge execution contract:");
    expect(wrapped).toContain("User request:\nimplement this feature");

    // Precedence: Soul contract is placed before execution contract and user request
    const soulIdx = wrapped.indexOf("Soul contract:");
    const execIdx = wrapped.indexOf("Agent Bridge execution contract:");
    const reqIdx = wrapped.indexOf("User request:");
    expect(soulIdx).toBeLessThan(execIdx);
    expect(execIdx).toBeLessThan(reqIdx);

    // Across CLI providers that wrap prompts at invocation time, the invocation receives the exact same Soul contract
    for (const bot of ["antigravity", "grok", "cursor"]) {
      const invocation = buildCliInvocation({
        bot,
        prompt: "implement this feature",
        sessionId: null,
        command: bot,
        model: null,
        soulContext,
      });
      const invocationText = [...invocation.args, invocation.stdin ?? "", invocation.prompt ?? ""].join("\n");
      expect(invocationText, bot).toContain("Soul contract:\nYou are a versatile pair programmer.");
      expect(invocationText, bot).toContain("Higher-priority bridge/system/developer instructions always win.");
    }
  });

  it("loads existing multi-section Markdown without modification or errors", () => {
    const legacySections = [
      "# SOUL.md — Operations Engineer",
      "",
      "## Identity",
      "You are Weaver: the calm, dependable operations engineer.",
      "",
      "## Values",
      "1. Boringly stable beats brilliantly flaky",
      "2. Radical transparency",
      "",
      "## Communication Style",
      "- Direct answer first.",
      "",
      "## Workflow",
      "- Red-green TDD.",
    ].join("\n");

    const path = tempSoulFile(legacySections);
    const context = loadSoulContext({ mode: "summary", path });
    expect(context).toBe(legacySections);
  });
});

