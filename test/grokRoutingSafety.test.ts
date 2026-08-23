import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getCliWorkingDir } from "../src/bridge.js";
import { buildCliInvocation } from "../src/cli.js";
import { openDb } from "../src/db.js";
import { getUserCliPreference, setUserCliPreference } from "../src/interactiveBot.js";
import { ProviderFallbackChain } from "../src/providerFallback.js";
import { PROVIDER_CONTRACT_VERSION, writeQualificationRecord } from "../src/providers/qualification.js";

function withGrokEnvironment<T>(run: (root: string, evidencePath: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "grok-routing-safety-"));
  const evidencePath = join(root, "qualification.json");
  const executable = join(root, "grok");
  writeFileSync(executable, "#!/bin/sh\necho 'grok 1.0.5'\n", "utf8");
  chmodSync(executable, 0o755);

  const previous = {
    evidencePath: process.env.AGENT_BRIDGE_PROVIDER_QUALIFICATION_PATH,
    command: process.env.GROK_COMMAND,
    apiKey: process.env.XAI_API_KEY,
    executionMode: process.env.GROK_EXECUTION_MODE,
  };
  process.env.AGENT_BRIDGE_PROVIDER_QUALIFICATION_PATH = evidencePath;
  process.env.GROK_COMMAND = executable;
  process.env.XAI_API_KEY = "test-key";
  delete process.env.GROK_EXECUTION_MODE;

  try {
    return run(root, evidencePath);
  } finally {
    if (previous.evidencePath === undefined) delete process.env.AGENT_BRIDGE_PROVIDER_QUALIFICATION_PATH;
    else process.env.AGENT_BRIDGE_PROVIDER_QUALIFICATION_PATH = previous.evidencePath;
    if (previous.command === undefined) delete process.env.GROK_COMMAND;
    else process.env.GROK_COMMAND = previous.command;
    if (previous.apiKey === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = previous.apiKey;
    if (previous.executionMode === undefined) delete process.env.GROK_EXECUTION_MODE;
    else process.env.GROK_EXECUTION_MODE = previous.executionMode;
  }
}

function writePassingGrokQualification(evidencePath: string): void {
  writeQualificationRecord({
    provider: "grok",
    providerVersion: "1.0.5",
    previousVersion: null,
    bridgeCommit: "e".repeat(40),
    contractVersion: PROVIDER_CONTRACT_VERSION,
    qualifiedAt: "2026-08-23T18:45:00.000Z",
    environment: "test",
    overall: "pass",
    checks: [
      { name: "version", status: "pass" },
      { name: "fresh_prompt", status: "pass" },
      { name: "session_resume", status: "pass" },
    ],
  }, evidencePath);
}

describe("Grok fail-closed routing", () => {
  it("does not enter Grok through capacity fallback without current passing qualification", () => {
    withGrokEnvironment((_root, _evidencePath) => {
      const db = openDb(":memory:");
      const chain = new ProviderFallbackChain(["codex", "grok"], db);
      expect(chain.getActiveCli("chat:1")).toBe("codex");
      expect(chain.advance("chat:1")).toBeNull();
      expect(chain.getChain()).toEqual(["codex"]);
    });
  });

  it("allows Grok fallback only after the exact installed binary has a current pass", () => {
    withGrokEnvironment((_root, evidencePath) => {
      writePassingGrokQualification(evidencePath);
      const db = openDb(":memory:");
      const chain = new ProviderFallbackChain(["codex", "grok"], db);
      expect(chain.advance("chat:1")).toBe("grok");
      expect(chain.getChain()).toEqual(["codex", "grok"]);
    });
  });

  it("filters an unqualified Grok-only chain from available fallback targets", () => {
    withGrokEnvironment(() => {
      const db = openDb(":memory:");
      const chain = new ProviderFallbackChain(["grok"], db);
      expect(chain.getChain()).toEqual([]);
      expect(chain.getActiveCli("chat:1")).toBe("grok");
    });
  });

  it("undoes an unavailable Grok preference written by a manual Discord-style switch", () => {
    withGrokEnvironment(() => {
      const db = openDb(":memory:");
      setUserCliPreference(db, "channel:1", "grok");
      const chain = new ProviderFallbackChain(["codex", "grok"], db);
      chain.setActiveCli("channel:1", "grok");
      expect(getUserCliPreference(db, "channel:1")).toBe("codex");
      expect(chain.getActiveCli("channel:1")).toBe("codex");
    });
  });

  it("blocks direct engine working-directory resolution before unqualified Grok can spawn", () => {
    withGrokEnvironment(() => {
      expect(() => getCliWorkingDir("grok")).toThrow(/current provider qualification passes/i);
    });
  });
});

describe("managed Grok execution mode", () => {
  it("defaults production Grok to safe even when the shared caller requests trusted mode", () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousMode = process.env.GROK_EXECUTION_MODE;
    process.env.NODE_ENV = "production";
    delete process.env.GROK_EXECUTION_MODE;
    try {
      const invocation = buildCliInvocation({
        bot: "grok",
        prompt: "test",
        sessionId: null,
        command: "grok",
        executionMode: "trusted",
        includeResponseContract: false,
      });
      expect(invocation.args).not.toContain("--always-approve");
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousMode === undefined) delete process.env.GROK_EXECUTION_MODE;
      else process.env.GROK_EXECUTION_MODE = previousMode;
    }
  });

  it("lets the Grok-specific safe mode suppress a shared trusted request", () => {
    const previous = process.env.GROK_EXECUTION_MODE;
    process.env.GROK_EXECUTION_MODE = "safe";
    try {
      const invocation = buildCliInvocation({
        bot: "grok",
        prompt: "test",
        sessionId: null,
        command: "grok",
        executionMode: "trusted",
        includeResponseContract: false,
      });
      expect(invocation.args).not.toContain("--always-approve");
    } finally {
      if (previous === undefined) delete process.env.GROK_EXECUTION_MODE;
      else process.env.GROK_EXECUTION_MODE = previous;
    }
  });

  it("keeps explicit Grok trusted mode available for custom deployments", () => {
    const previous = process.env.GROK_EXECUTION_MODE;
    process.env.GROK_EXECUTION_MODE = "trusted";
    try {
      const invocation = buildCliInvocation({
        bot: "grok",
        prompt: "test",
        sessionId: null,
        command: "grok",
        executionMode: "safe",
        includeResponseContract: false,
      });
      expect(invocation.args).toContain("--always-approve");
    } finally {
      if (previous === undefined) delete process.env.GROK_EXECUTION_MODE;
      else process.env.GROK_EXECUTION_MODE = previous;
    }
  });

  it("ships safe Grok defaults in both managed interactive units", () => {
    const telegramUnit = readFileSync(resolve(process.cwd(), "systemd/agent-bridge-interactive.service"), "utf8");
    const discordUnit = readFileSync(resolve(process.cwd(), "systemd/agent-bridge-discord-interactive.service"), "utf8");
    expect(telegramUnit).toContain("Environment=GROK_EXECUTION_MODE=safe");
    expect(discordUnit).toContain("Environment=GROK_EXECUTION_MODE=safe");
  });
});
