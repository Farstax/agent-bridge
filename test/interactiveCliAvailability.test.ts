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

  it("detects provider credential files when the runtimes exist", () => {
    const homeDir = "/home/tester";
    const paths = resolveInteractiveCliAuthPaths(homeDir);
    const existing = new Set([paths.codex, paths.claude]);
    const available = getAvailableCliKinds({
      homeDir,
      exists: (path) => existing.has(path),
      commandExists: () => true,
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

  it("detects the current Antigravity OAuth token path when the runtime exists", () => {
    const homeDir = "/home/tester";
    const paths = resolveInteractiveCliAuthPaths(homeDir);
    const available = getAvailableCliKinds({
      homeDir,
      exists: (path) => path === paths.antigravity[0],
      commandExists: () => true,
      readCursorStatus: cursorStatusUnavailable,
    });

    expect(available).toEqual(new Set<CliKind>(["antigravity"]));
  });

  it("treats authenticated Grok as available without qualification evidence when the runtime exists", () => {
    const homeDir = "/home/tester";
    const paths = resolveInteractiveCliAuthPaths(homeDir);
    const available = getAvailableCliKinds({
      homeDir,
      exists: (path) => path === paths.grok[0],
      commandExists: () => true,
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
      commandExists: () => true,
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
  ] as const)("accepts only a verified %s API key when its runtime exists", (provider, cliKind, envVar) => {
    const env = { [envVar]: `candidate-${provider}-key` };
    const verified = getAvailableCliKinds({
      homeDir: "/home/tester",
      exists: () => false,
      commandExists: () => true,
      failedProviders: new Set(),
      env,
      verifyApiKey: (candidate: ProviderId) => candidate === provider,
      readCursorStatus: cursorStatusUnavailable,
    });
    const rejected = getAvailableCliKinds({
      homeDir: "/home/tester",
      exists: () => false,
      commandExists: () => true,
      failedProviders: new Set(),
      env,
      verifyApiKey: () => false,
      readCursorStatus: cursorStatusUnavailable,
    });

    expect(verified).toEqual(new Set<CliKind>([cliKind]));
    expect(rejected).toEqual(new Set<CliKind>());
  });

  it.each([
    ["codex", "CODEX_API_KEY"],
    ["claude", "ANTHROPIC_API_KEY"],
    ["agy", "GEMINI_API_KEY"],
    ["grok", "XAI_API_KEY"],
    ["cursor", "CURSOR_API_KEY"],
  ] as const)("does not advertise %s from a verified API key when its executable is missing", (provider, envVar) => {
    const available = getAvailableCliKinds({
      homeDir: "/home/tester",
      exists: () => false,
      commandExists: () => false,
      failedProviders: new Set(),
      env: { [envVar]: `candidate-${provider}-key` },
      verifyApiKey: (candidate: ProviderId) => candidate === provider,
      readCursorStatus: cursorStatusUnavailable,
    });

    expect(available).toEqual(new Set<CliKind>());
  });

  it("does not advertise executable providers without valid authentication", () => {
    const available = getAvailableCliKinds({
      homeDir: "/home/tester",
      exists: () => false,
      commandExists: () => true,
      failedProviders: new Set(),
      env: {},
      verifyApiKey: () => false,
      readCursorStatus: () => ({ isAuthenticated: false }),
    });

    expect(available).toEqual(new Set<CliKind>());
  });

  it("uses the configured provider command as the executable availability contract", () => {
    const homeDir = "/home/tester";
    const paths = resolveInteractiveCliAuthPaths(homeDir);
    const commands = {
      codex: "/runtime/codex-custom",
      claude: "/runtime/claude-custom",
      agy: "/runtime/agy-custom",
      grok: "/runtime/grok-custom",
      cursor: "/runtime/cursor-custom",
    } as const;
    const seen: string[] = [];
    const available = getAvailableCliKinds({
      homeDir,
      exists: (path) => [paths.codex, paths.claude, paths.antigravity[0], paths.grok[0]].includes(path),
      commandExists: (command) => {
        seen.push(command);
        return true;
      },
      failedProviders: new Set(),
      env: {
        CODEX_COMMAND: commands.codex,
        CLAUDE_COMMAND: commands.claude,
        ANTIGRAVITY_COMMAND: commands.agy,
        GROK_COMMAND: commands.grok,
        CURSOR_COMMAND: commands.cursor,
      },
      readCursorStatus: () => ({ isAuthenticated: true }),
    });

    expect(available).toEqual(new Set<CliKind>(["codex", "claude", "antigravity", "grok", "cursor"]));
    expect(new Set(seen)).toEqual(new Set(Object.values(commands)));
  });

  it.each([
    ["codex", "codex", "/runtime/codex-custom"],
    ["claude", "claude", "/runtime/claude-custom"],
    ["agy", "antigravity", "/runtime/agy-custom"],
    ["grok", "grok", "/runtime/grok-custom"],
    ["cursor", "cursor", "/runtime/cursor-custom"],
  ] as const)("requires the executable for authenticated %s", (provider, cliKind, missingCommand) => {
    const homeDir = "/home/tester";
    const paths = resolveInteractiveCliAuthPaths(homeDir);
    const available = getAvailableCliKinds({
      homeDir,
      exists: (path) => [paths.codex, paths.claude, paths.antigravity[0], paths.grok[0]].includes(path),
      commandExists: (command) => command !== missingCommand,
      failedProviders: new Set(),
      env: {
        CODEX_COMMAND: "/runtime/codex-custom",
        CLAUDE_COMMAND: "/runtime/claude-custom",
        ANTIGRAVITY_COMMAND: "/runtime/agy-custom",
        GROK_COMMAND: "/runtime/grok-custom",
        CURSOR_COMMAND: "/runtime/cursor-custom",
      },
      readCursorStatus: () => ({ isAuthenticated: true }),
    });

    expect(available.has(cliKind as CliKind)).toBe(false);
    expect(available.size).toBe(4);
    expect(provider).toBeTruthy();
  });

  it.each([
    ["codex", "CODEX_API_KEY"],
    ["claude", "ANTHROPIC_API_KEY"],
    ["agy", "GEMINI_API_KEY"],
    ["grok", "XAI_API_KEY"],
  ] as const)("keeps an authenticated %s account available when its optional key is invalid", (provider, envVar) => {
    const homeDir = "/home/tester";
    const paths = resolveInteractiveCliAuthPaths(homeDir);
    const accountPaths = provider === "codex"
      ? [paths.codex]
      : provider === "claude"
        ? [paths.claude]
        : provider === "agy"
          ? [paths.antigravity[0]]
          : [paths.grok[0]];
    const expected = provider === "agy" ? "antigravity" : provider;
    const available = getAvailableCliKinds({
      homeDir,
      exists: (path) => accountPaths.includes(path),
      commandExists: () => true,
      failedProviders: new Set(),
      env: { [envVar]: `invalid-${provider}-key` },
      verifyApiKey: () => false,
      readCursorStatus: cursorStatusUnavailable,
    });

    expect(available.has(expected as CliKind)).toBe(true);
  });

  it("keeps an authenticated Cursor account available when its optional key is invalid and runtime exists", () => {
    const available = getAvailableCliKinds({
      homeDir: "/home/tester",
      exists: () => false,
      commandExists: () => true,
      failedProviders: new Set(),
      env: { CURSOR_API_KEY: "invalid-cursor-key" },
      verifyApiKey: () => false,
      readCursorStatus: () => ({ isAuthenticated: true }),
    });
    expect(available).toEqual(new Set<CliKind>(["cursor"]));
  });

  it("treats Cursor as available only when account status reports authenticated without a verified API key", () => {
    const available = getAvailableCliKinds({
      homeDir: "/home/tester",
      exists: () => false,
      commandExists: () => true,
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
