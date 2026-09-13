import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { interactiveChainKinds, parseCliChain } from "../src/providers/selection.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const expectedChain = ["codex", "claude", "antigravity", "grok", "cursor"] as const;

function read(pathname: string): string {
  return fs.readFileSync(path.join(root, pathname), "utf8");
}

function extractCodeFallback(pathname: string): string[] {
  const match = read(pathname).match(/fallback:\s*\[([^\]]+)\]/);
  if (!match) throw new Error(`missing fallback in ${pathname}`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

function extractEnvChain(pathname: string): string[] {
  const match = read(pathname).match(/^INTERACTIVE_CLI_CHAIN=(.+)$/m);
  if (!match) throw new Error(`missing INTERACTIVE_CLI_CHAIN in ${pathname}`);
  return match[1].split(",");
}

function extractInstallerDefaultChains(): string[][] {
  const matches = [...read("scripts/install.sh").matchAll(/INTERACTIVE_CLI_CHAIN=\$\{INTERACTIVE_CLI_CHAIN:-([^}]+)\}/g)];
  return matches.map((match) => match[1].split(","));
}

describe("Cursor default fallback policy", () => {
  it("resolves the unset Telegram and Discord chains to Cursor-last defaults", () => {
    expect(extractCodeFallback("src/index-interactive.ts")).toEqual(expectedChain);
    expect(extractCodeFallback("src/index-discord-interactive.ts")).toEqual(expectedChain);
    expect(parseCliChain(undefined, {
      allowed: interactiveChainKinds(),
      fallback: expectedChain,
    })).toEqual(expectedChain);
  });

  it("keeps operator examples aligned with code-level defaults", () => {
    expect(extractEnvChain(".env.interactive.example")).toEqual(expectedChain);
    expect(extractEnvChain(".env.discord-interactive.example")).toEqual(expectedChain);
  });

  it("keeps installer-generated service defaults aligned with code-level defaults", () => {
    expect(extractInstallerDefaultChains()).toEqual([expectedChain, expectedChain]);
  });

  it("preserves explicit INTERACTIVE_CLI_CHAIN overrides", () => {
    expect(parseCliChain("claude,cursor", {
      allowed: interactiveChainKinds(),
      fallback: expectedChain,
    })).toEqual(["claude", "cursor"]);
  });

  it("ensures cursorRuntime tests do not assert that Cursor is absent or opt-in only", () => {
    const runtimeTests = read("test/cursorRuntime.test.ts");
    expect(runtimeTests).not.toMatch(/absent from the production default/i);
    expect(runtimeTests).not.toMatch(/selectable only through an explicit/i);
    expect(runtimeTests).not.toMatch(/expect\(productionDefault\)\.not\.toContain\("cursor"\)/);
  });
});
