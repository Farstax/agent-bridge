import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { interactiveChainKinds, parseCliChain } from "../src/providers/selection.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const expectedChain = ["codex", "claude", "grok", "antigravity", "cursor"] as const;

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

describe("Cursor default fallback policy", () => {
  it("resolves the unset Telegram and Discord chains to Cursor-last defaults", () => {
    for (const pathname of ["src/index-interactive.ts", "src/index-discord-interactive.ts"]) {
      const fallback = extractCodeFallback(pathname);
      expect(fallback, pathname).toEqual(expectedChain);
      expect(parseCliChain(undefined, { allowed: interactiveChainKinds(), fallback }), pathname).toEqual(expectedChain);
    }
  });

  it("keeps operator examples aligned with code-level defaults", () => {
    expect(extractEnvChain(".env.interactive.example")).toEqual(expectedChain);
    expect(extractEnvChain(".env.discord-interactive.example")).toEqual(expectedChain);
  });

  it("preserves explicit INTERACTIVE_CLI_CHAIN overrides", () => {
    expect(parseCliChain("claude,cursor", {
      allowed: interactiveChainKinds(),
      fallback: expectedChain,
    })).toEqual(["claude", "cursor"]);
  });
});
