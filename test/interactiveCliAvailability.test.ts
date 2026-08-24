import { describe, expect, it } from "vitest";
import {
  buildCliKeyboard,
  buildCliStatusText,
  getSelectableCliKinds,
  resolveAvailableCliPreference,
  type CliKind,
} from "../src/interactiveBot.js";
import { getAvailableCliKinds, resolveInteractiveCliAuthPaths } from "../src/interactiveCliAuth.js";

const cursorStatusUnavailable = () => {
  throw new Error("Cursor status unavailable in test");
};

describe("interactive CLI availability filtering", () => {
  it("filters the switch keyboard to available CLIs", () => {
    const available = new Set<CliKind>(["claude"]);
    const keyboard = buildCliKeyboard("codex", available);
    const buttons = keyboard.inline_keyboard.flat();

    expect(buttons.map((button) => button.callback_data)).toEqual(["cli:claude"]);
    expect(buttons.find((button) => button.text.includes("✓"))?.text).toContain("claude");
  });

  it("filters status text to available CLIs", () => {
    const available = new Set<CliKind>(["claude"]);
    const text = buildCliStatusText("codex", available);

    expect(text).toContain("Active CLI: **claude**");
    expect(text).toContain("Available: claude");
    expect(text).not.toContain("Available: codex");
    expect(text).not.toContain("antigravity");
  });

  it("does not keep unavailable providers when no runtime check passes", () => {
    const available = getAvailableCliKinds({
      homeDir: "/tmp/no-creds",
      exists: () => false,
      commandExists: () => false,
      readCursorStatus: cursorStatusUnavailable,
    });

    expect(available).toEqual(new Set<CliKind>());
    expect(getSelectableCliKinds(available)).toEqual([]);
    expect(resolveAvailableCliPreference("codex", available)).toBeNull();
    expect(buildCliKeyboard("codex", available).inline_keyboard).toEqual([]);
    expect(buildCliStatusText("codex", available)).toContain("Available: none");
  });

  it("detects provider credential files", () => {
    const homeDir = "/home/tester";
    const paths = resolveInteractiveCliAuthPaths(homeDir);
    const existing = new Set([paths.codex, paths.claude]);
    const available = getAvailableCliKinds({
      homeDir,
      exists: (path) => existing.has(path),
      commandExists: () => false,
      readCursorStatus: cursorStatusUnavailable,
    });

    expect(available).toEqual(new Set<CliKind>(["codex", "claude"]));
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
      readCursorStatus: cursorStatusUnavailable,
    });

    expect(available).toEqual(new Set<CliKind>(["antigravity"]));
  });

  it("treats authenticated Grok as available without qualification evidence", () => {
    const homeDir = "/home/tester";
    const paths = resolveInteractiveCliAuthPaths(homeDir);
    const available = getAvailableCliKinds({
      homeDir,
      exists: (path) => path === paths.grok[0],
      commandExists: () => false,
      failedProviders: new Set(),
      readCursorStatus: cursorStatusUnavailable,
    });

    expect(paths.grok).toEqual([
      "/home/tester/.grok/auth.json",
      "/home/tester/.config/grok/auth.json",
    ]);
    expect(available).toEqual(new Set<CliKind>(["grok"]));
    expect(getSelectableCliKinds()).not.toContain("grok");
    expect(getSelectableCliKinds(available)).toEqual(["grok"]);
  });

  it("suppresses authenticated Grok after a current deterministic qualification failure", () => {
    const homeDir = "/home/tester";
    const paths = resolveInteractiveCliAuthPaths(homeDir);
    const available = getAvailableCliKinds({
      homeDir,
      exists: (path) => path === paths.grok[0],
      commandExists: () => false,
      failedProviders: new Set(["grok"]),
      readCursorStatus: cursorStatusUnavailable,
    });

    expect(available).toEqual(new Set<CliKind>());
  });

  it("accepts XAI_API_KEY as Grok authentication without requiring a positive qualification", () => {
    const available = getAvailableCliKinds({
      homeDir: "/home/tester",
      exists: () => false,
      commandExists: () => false,
      failedProviders: new Set(),
      env: { XAI_API_KEY: "xai-test" },
      readCursorStatus: cursorStatusUnavailable,
    });

    expect(available).toEqual(new Set<CliKind>(["grok"]));
  });

  it("treats Cursor as available only when status reports authenticated", () => {
    const available = getAvailableCliKinds({
      homeDir: "/home/tester",
      exists: () => false,
      commandExists: () => false,
      failedProviders: new Set(),
      readCursorStatus: () => ({ isAuthenticated: true }),
    });
    expect(available).toEqual(new Set<CliKind>(["cursor"]));

    const unavailable = getAvailableCliKinds({
      homeDir: "/home/tester",
      exists: () => true,
      commandExists: () => true,
      failedProviders: new Set(),
      readCursorStatus: () => ({ isAuthenticated: false }),
    });
    expect(unavailable.has("cursor")).toBe(false);
  });
});
