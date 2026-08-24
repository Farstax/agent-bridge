import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const expectedChain = ["codex", "claude", "grok", "antigravity", "cursor"];

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
  it("keeps Telegram, Discord, and operator examples on the same default chain", () => {
    expect(extractCodeFallback("src/index-interactive.ts")).toEqual(expectedChain);
    expect(extractCodeFallback("src/index-discord-interactive.ts")).toEqual(expectedChain);
    expect(extractEnvChain(".env.interactive.example")).toEqual(expectedChain);
    expect(extractEnvChain(".env.discord-interactive.example")).toEqual(expectedChain);
  });
});
