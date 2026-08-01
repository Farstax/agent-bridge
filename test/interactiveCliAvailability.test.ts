import { describe, expect, it } from "vitest";
import {
  buildCliKeyboard,
  buildCliStatusText,
  getSelectableCliKinds,
  resolveAvailableCliPreference,
  type CliKind,
} from "../src/interactiveBot.js";
import { getAvailableCliKinds, resolveInteractiveCliAuthPaths } from "../src/interactiveCliAuth.js";

describe("interactive CLI availability filtering", () => {
  it("filters the switch keyboard to available CLIs", () => {
    const available = new Set<CliKind>(["claude", "kimchi"]);
    const keyboard = buildCliKeyboard("codex", available);
    const buttons = keyboard.inline_keyboard.flat();

    expect(buttons.map((button) => button.callback_data)).toEqual(["cli:claude", "cli:kimchi"]);
    expect(buttons.find((button) => button.text.includes("✓"))?.text).toContain("claude");
  });

  it("filters status text to available CLIs", () => {
    const available = new Set<CliKind>(["claude", "kimchi"]);
    const text = buildCliStatusText("codex", available);

    expect(text).toContain("Active CLI: **claude**");
    expect(text).toContain("Available: claude, kimchi");
    expect(text).not.toContain("Available: codex");
    expect(text).not.toContain("antigravity");
  });

  it("does not keep kimchi available when no runtime check passes", () => {
    const available = getAvailableCliKinds({
      homeDir: "/tmp/no-creds",
      exists: () => false,
      commandExists: () => false,
    });

    expect(available).toEqual(new Set<CliKind>());
    expect(getSelectableCliKinds(available)).toEqual([]);
    expect(resolveAvailableCliPreference("codex", available)).toBeNull();
    expect(buildCliKeyboard("codex", available).inline_keyboard).toEqual([]);
    expect(buildCliStatusText("codex", available)).toContain("Available: none");
  });

  it("detects kimchi when the executable/runtime check passes", () => {
    const available = getAvailableCliKinds({
      homeDir: "/tmp/no-creds",
      exists: () => false,
      commandExists: (command) => command === "kimchi",
    });

    expect(available).toEqual(new Set<CliKind>(["kimchi"]));
  });

  it("detects provider credential files and kimchi runtime availability", () => {
    const homeDir = "/home/tester";
    const paths = resolveInteractiveCliAuthPaths(homeDir);
    const existing = new Set([paths.codex, paths.claude]);
    const available = getAvailableCliKinds({
      homeDir,
      exists: (path) => existing.has(path),
      commandExists: (command) => command === "kimchi",
    });

    expect(available).toEqual(new Set<CliKind>(["codex", "claude", "kimchi"]));
    expect(paths.codex).toBe("/home/tester/.codex/auth.json");
    expect(paths.claude).toBe("/home/tester/.claude/.credentials.json");
    expect(paths.antigravity).toEqual([
      "/home/tester/.gemini/antigravity-cli/antigravity-oauth-token",
      "/home/tester/.gemini/oauth_creds.json",
    ]);
  });

  it("detects the current Antigravity OAuth token path", () => {
    const homeDir = "/home/tester";
    const paths = resolveInteractiveCliAuthPaths(homeDir);
    const available = getAvailableCliKinds({
      homeDir,
      exists: (path) => path === paths.antigravity[0],
      commandExists: () => false,
    });

    expect(available).toEqual(new Set<CliKind>(["antigravity"]));
  });
});
