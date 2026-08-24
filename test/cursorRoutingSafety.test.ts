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
  writeFileSync(executable, `#!/bin/sh
if [ "$1" = "status" ]; then
  echo '{"status":"authenticated","isAuthenticated":true,"hasAccessToken":true,"hasRefreshToken":true}'
  exit 0
fi
echo '2026.08.11-e8db854'
`, "utf8");
  chmodSync(executable, 0o755);

  const previous = {
    evidencePath: process.env.AGENT_BRIDGE_PROVIDER_QUALIFICATION_PATH,
    command: process.env.CURSOR_COMMAND,
    apiKey: process.env.CURSOR_API_KEY,
  };
  process.env.AGENT_BRIDGE_PROVIDER_QUALIFICATION_PATH = evidencePath;
  process.env.CURSOR_COMMAND = executable;
  delete process.env.CURSOR_API_KEY;

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
  it("skips Cursor when only CURSOR_API_KEY is present and status is unavailable", () => {
    const previous = {
      evidencePath: process.env.AGENT_BRIDGE_PROVIDER_QUALIFICATION_PATH,
      command: process.env.CURSOR_COMMAND,
      apiKey: process.env.CURSOR_API_KEY,
    };
    const root = mkdtempSync(join(tmpdir(), "cursor-api-key-only-"));
    const evidencePath = join(root, "qualification.json");
    const executable = join(root, "cursor-agent");
    writeFileSync(executable, "#!/bin/sh\nexit 1\n", "utf8");
    chmodSync(executable, 0o755);
    process.env.AGENT_BRIDGE_PROVIDER_QUALIFICATION_PATH = evidencePath;
    process.env.CURSOR_COMMAND = executable;
    process.env.CURSOR_API_KEY = "not-supported";
    try {
      const db = openDb(":memory:");
      const chain = new ProviderFallbackChain(["codex", "cursor", "antigravity"], db);
      expect(chain.getChain()).toEqual(["codex", "antigravity"]);
      expect(chain.advance("chat:1")).toBe("antigravity");
    } finally {
      if (previous.evidencePath === undefined) delete process.env.AGENT_BRIDGE_PROVIDER_QUALIFICATION_PATH;
      else process.env.AGENT_BRIDGE_PROVIDER_QUALIFICATION_PATH = previous.evidencePath;
      if (previous.command === undefined) delete process.env.CURSOR_COMMAND;
      else process.env.CURSOR_COMMAND = previous.command;
      if (previous.apiKey === undefined) delete process.env.CURSOR_API_KEY;
      else process.env.CURSOR_API_KEY = previous.apiKey;
    }
  });

  it("allows authenticated Cursor through an explicit chain without qualification evidence", () => {
    withCursorEnvironment(() => {
      const db = openDb(":memory:");
      const chain = new ProviderFallbackChain(["codex", "cursor", "antigravity"], db);
      expect(chain.getActiveCli("chat:1")).toBe("codex");
      expect(chain.advance("chat:1")).toBe("cursor");
      expect(chain.getChain()).toEqual(["codex", "cursor", "antigravity"]);
    });
  });

  it("allows authenticated Cursor as the final fallback target", () => {
    withCursorEnvironment(() => {
      const db = openDb(":memory:");
      const chain = new ProviderFallbackChain(["codex", "claude", "grok", "antigravity", "cursor"], db);
      expect(chain.advance("chat:1")).toBe("claude");
      expect(chain.advance("chat:1")).toBe("grok");
      expect(chain.advance("chat:1")).toBe("antigravity");
      expect(chain.advance("chat:1")).toBe("cursor");
      expect(chain.isChainExhausted("chat:1")).toBe(true);
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

  it("places Cursor last on both default interactive fallback chains", () => {
    const interactive = readFileSync(join(repoRoot, "src/index-interactive.ts"), "utf8");
    const discord = readFileSync(join(repoRoot, "src/index-discord-interactive.ts"), "utf8");
    const expected = /fallback:\s*\["codex",\s*"claude",\s*"grok",\s*"antigravity",\s*"cursor"\]/;
    expect(interactive).toMatch(expected);
    expect(discord).toMatch(expected);
  });
});
