import { describe, expect, it } from "vitest";
import {
  buildCliKeyboard,
  buildCliStatusText,
  getSelectableCliKinds,
  resolveAvailableCliPreference,
  type CliKind,
} from "../src/interactiveBot.js";
import { getAvailableCliKinds, resolveInteractiveCliAuthPaths } from "../src/interactiveCliAuth.js";
import type { ProviderId } from "../src/providers/types.js";

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

  it.each([
    ["codex", "codex", "CODEX_API_KEY"],
    ["claude", "claude", "ANTHROPIC_API_KEY"],
    ["agy", "antigravity", "GEMINI_API_KEY"],
    ["grok", "grok", "XAI_API_KEY"],
    ["cursor", "cursor", "CURSOR_API_KEY"],
  ] as const)("accepts only a verified %s API key", (provider, cliKind, envVar) => {
    const env = { [envVar]: `candidate-${provider}-key` };
    const verified = getAvailableCliKinds({
      homeDir: "/home/tester",
      exists: () => false,
      commandExists: () => false,
      failedProviders: new Set(),
      env,
      verifyApiKey: (candidate: ProviderId) => candidate === provider,
      readCursorStatus: cursorStatusUnavailable,
    });
    const rejected = getAvailableCliKinds({
      homeDir: "/home/tester",
      exists: () => false,
      commandExists: () => false,
      failedProviders: new Set(),
      env,
      verifyApiKey: () => false,
      readCursorStatus: cursorStatusUnavailable,
    });

    expect(verified).toEqual(new Set<CliKind>([cliKind]));
    expect(rejected).toEqual(new Set<CliKind>());
  });

  it("treats Cursor as available only when account status reports authenticated and no API key is configured", () => {
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
