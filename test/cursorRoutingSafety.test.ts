import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getCliWorkingDir } from "../src/bridge.js";
import { openDb } from "../src/db.js";
import { getUserCliPreference, setUserCliPreference } from "../src/interactiveBot.js";
import { ProviderFallbackChain } from "../src/providerFallback.js";
import { PROVIDER_CONTRACT_VERSION, writeQualificationRecord } from "../src/providers/qualification.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function withCursorEnvironment<T>(run: (root: string, evidencePath: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "cursor-routing-safety-"));
  const evidencePath = join(root, "qualification.json");
  const executable = join(root, "cursor-agent");
  writeFileSync(executable, "#!/bin/sh\necho '2026.08.11-e8db854'\n", "utf8");
  chmodSync(executable, 0o755);
  writeFileSync(join(root, "auth.json"), "{\"token\":\"redacted\"}\n", "utf8");

  const previous = {
    evidencePath: process.env.AGENT_BRIDGE_PROVIDER_QUALIFICATION_PATH,
    command: process.env.CURSOR_COMMAND,
    apiKey: process.env.CURSOR_API_KEY,
  };
  process.env.AGENT_BRIDGE_PROVIDER_QUALIFICATION_PATH = evidencePath;
  process.env.CURSOR_COMMAND = executable;
  process.env.CURSOR_API_KEY = "test-key";

  try {
    return run(root, evidencePath);
  } finally {
    if (previous.evidencePath === undefined) delete process.env.AGENT_BRIDGE_PROVIDER_QUALIFICATION_PATH;
    else process.env.AGENT_BRIDGE_PROVIDER_QUALIFICATION_PATH = previous.evidencePath;
    if (previous.command === undefined) delete process.env.CURSOR_COMMAND;
    else process.env.CURSOR_COMMAND = previous.command;
    if (previous.apiKey === undefined) delete process.env.CURSOR_API_KEY;
    else process.env.CURSOR_API_KEY = previous.apiKey;
  }
}

function writeFailedCursorQualification(evidencePath: string): void {
  writeQualificationRecord({
    provider: "cursor",
    providerVersion: "2026.08.11-e8db854",
    previousVersion: null,
    bridgeCommit: "e".repeat(40),
    contractVersion: PROVIDER_CONTRACT_VERSION,
    qualifiedAt: "2026-08-24T12:00:00.000Z",
    environment: "test",
    overall: "fail",
    checks: [
      { name: "version", status: "pass" },
      { name: "fresh_prompt", status: "fail", diagnostic: "contract regression" },
      { name: "session_resume", status: "not_applicable" },
    ],
  }, evidencePath);
}

describe("Cursor routing safety", () => {
  it("allows authenticated Cursor through an explicit chain without qualification evidence", () => {
    withCursorEnvironment(() => {
      const db = openDb(":memory:");
      const chain = new ProviderFallbackChain(["codex", "cursor", "antigravity"], db);
      expect(chain.getActiveCli("chat:1")).toBe("codex");
      expect(chain.advance("chat:1")).toBe("cursor");
      expect(chain.getChain()).toEqual(["codex", "cursor", "antigravity"]);
    });
  });

  it("skips Cursor when current qualification evidence proves a deterministic failure", () => {
    withCursorEnvironment((_root, evidencePath) => {
      writeFailedCursorQualification(evidencePath);
      const db = openDb(":memory:");
      const chain = new ProviderFallbackChain(["codex", "cursor", "antigravity"], db);
      expect(chain.advance("chat:1")).toBe("antigravity");
      expect(chain.getChain()).toEqual(["codex", "antigravity"]);
    });
  });

  it("undoes a Cursor preference when current qualification evidence proves failure", () => {
    withCursorEnvironment((_root, evidencePath) => {
      writeFailedCursorQualification(evidencePath);
      const db = openDb(":memory:");
      setUserCliPreference(db, "channel:1", "cursor");
      const chain = new ProviderFallbackChain(["codex", "cursor"], db);
      chain.setActiveCli("channel:1", "cursor");
      expect(getUserCliPreference(db, "channel:1")).toBe("codex");
      expect(chain.getActiveCli("channel:1")).toBe("codex");
    });
  });

  it("blocks direct Cursor execution after a current deterministic qualification failure", () => {
    withCursorEnvironment((_root, evidencePath) => {
      writeFailedCursorQualification(evidencePath);
      expect(() => getCliWorkingDir("cursor")).toThrow(/qualification failure|unavailable/i);
    });
  });

  it("does not place Cursor on the default interactive fallback chain", () => {
    const interactive = readFileSync(join(repoRoot, "src/index-interactive.ts"), "utf8");
    const discord = readFileSync(join(repoRoot, "src/index-discord-interactive.ts"), "utf8");
    expect(interactive).toMatch(/fallback:\s*\["codex",\s*"claude",\s*"grok",\s*"antigravity"\]/);
    expect(discord).toMatch(/fallback:\s*\["codex",\s*"claude",\s*"grok",\s*"antigravity"\]/);
    expect(interactive).not.toMatch(/fallback:\s*\[[^\]]*cursor/);
    expect(discord).not.toMatch(/fallback:\s*\[[^\]]*cursor/);
  });
});
