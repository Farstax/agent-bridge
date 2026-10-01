import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { getAvailableCliKinds } from "../src/interactiveCliAuth.js";
import { resolveProviderRuntime } from "../src/providers/acpRuntime.js";
import { PROVIDER_CONTRACT_VERSION, writeQualificationRecord } from "../src/providers/qualification.js";
import { getQualificationFailedProviders, getQualificationPassedProviders } from "../src/providers/qualificationStatus.js";
import { ProviderFallbackChain } from "../src/providerFallback.js";

describe("provider qualification routing", () => {
  it("reads hard failures from persisted qualification evidence for the installed version", () => {
    const root = mkdtempSync(join(tmpdir(), "qualification-routing-"));
    const evidencePath = join(root, "qualification.json");
    writeQualificationRecord({
      provider: "agy",
      executionRuntime: resolveProviderRuntime("agy", {}).runtimeIdentity,
      providerVersion: "1.2.1",
      previousVersion: null,
      bridgeCommit: "e".repeat(40),
      contractVersion: PROVIDER_CONTRACT_VERSION,
      qualifiedAt: "2026-08-10T17:00:00.000Z",
      environment: "managed-appliance",
      overall: "fail",
      checks: [
        { name: "version", status: "pass" },
        { name: "fresh_prompt", status: "fail", diagnostic: "ACP structured error contract drift" },
        { name: "session_resume", status: "not_applicable" },
      ],
    }, evidencePath);
    writeQualificationRecord({
      provider: "claude",
      executionRuntime: "native:claude",
      providerVersion: "2.3.4",
      previousVersion: "2.3.3",
      bridgeCommit: "e".repeat(40),
      contractVersion: PROVIDER_CONTRACT_VERSION,
      qualifiedAt: "2026-08-10T17:00:01.000Z",
      environment: "managed-appliance",
      overall: "degraded",
      checks: [
        { name: "version", status: "pass" },
        { name: "fresh_prompt", status: "not_authenticated" },
        { name: "session_resume", status: "not_applicable" },
      ],
    }, evidencePath);

    expect([...getQualificationFailedProviders(evidencePath, {
      agy: "1.2.1",
      claude: "2.3.4",
    })]).toEqual(["agy"]);
  });

  it("does not block a newly installed version using stale failure evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "qualification-routing-version-change-"));
    const evidencePath = join(root, "qualification.json");
    writeQualificationRecord({
      provider: "agy",
      executionRuntime: "native:agy",
      providerVersion: "1.1.12",
      previousVersion: "1.1.11",
      bridgeCommit: "e".repeat(40),
      contractVersion: PROVIDER_CONTRACT_VERSION,
      qualifiedAt: "2026-08-10T17:00:00.000Z",
      environment: "managed-appliance",
      overall: "fail",
      checks: [
        { name: "version", status: "pass" },
        { name: "fresh_prompt", status: "fail", diagnostic: "native JSON contract drift" },
        { name: "session_resume", status: "not_applicable" },
      ],
    }, evidencePath);

    expect([...getQualificationFailedProviders(evidencePath, { agy: "1.1.13" })]).toEqual([]);
  });

  it("keeps a runnable provider selectable when its current qualification evidence fails", () => {
    const root = mkdtempSync(join(tmpdir(), "qualification-routing-availability-"));
    const evidencePath = join(root, "qualification.json");
    const claudeAcp = join(root, "claude-acp");
    const env = {
      ...process.env,
      AGENT_BRIDGE_PROVIDER_QUALIFICATION_PATH: evidencePath,
      CLAUDE_ACP_COMMAND: claudeAcp,
    };
    try {
      writeFileSync(claudeAcp, "#!/usr/bin/env bash\nprintf '0.81.2\\n'\n", { mode: 0o755 });
      chmodSync(claudeAcp, 0o755);
      writeQualificationRecord({
        provider: "claude",
        executionRuntime: resolveProviderRuntime("claude", env).runtimeIdentity,
        providerVersion: "0.81.2",
        previousVersion: null,
        bridgeCommit: "e".repeat(40),
        contractVersion: PROVIDER_CONTRACT_VERSION,
        qualifiedAt: "2026-10-01T00:00:00.000Z",
        environment: "managed-appliance",
        overall: "fail",
        checks: [
          { name: "version", status: "pass" },
          { name: "fresh_prompt", status: "fail", diagnostic: "contract drift" },
          { name: "session_resume", status: "not_applicable" },
          { name: "repository_grounding", status: "not_applicable" },
        ],
      }, evidencePath);
      vi.stubEnv("AGENT_BRIDGE_PROVIDER_QUALIFICATION_PATH", evidencePath);
      vi.stubEnv("CLAUDE_ACP_COMMAND", claudeAcp);

      expect(getQualificationFailedProviders()).toEqual(new Set(["claude"]));
      const available = getAvailableCliKinds({
        homeDir: root,
        env,
        exists: () => true,
        commandExists: (command) => command === claudeAcp,
        agyRuntimeReady: () => false,
        readCursorStatus: () => ({ isAuthenticated: false }),
      });

      expect(available.has("claude")).toBe(true);
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps every authenticated managed provider selectable when current qualification evidence fails", () => {
    const root = mkdtempSync(join(tmpdir(), "qualification-routing-provider-wide-"));
    const evidencePath = join(root, "qualification.json");
    const providers = [
      ["codex", "CODEX_ACP_COMMAND"],
      ["claude", "CLAUDE_ACP_COMMAND"],
      ["agy", "AGY_ACP_COMMAND"],
      ["grok", "GROK_ACP_COMMAND"],
      ["cursor", "CURSOR_ACP_COMMAND"],
    ] as const;
    const env: Record<string, string | undefined> = {
      ...process.env,
      AGENT_BRIDGE_PROVIDER_QUALIFICATION_PATH: evidencePath,
    };
    try {
      for (const [provider, envKey] of providers) {
        const command = join(root, `${provider}-acp`);
        writeFileSync(command, `#!/usr/bin/env bash\nprintf '${resolveProviderRuntime(provider, env).selectedVersion}\\n'\n`, { mode: 0o755 });
        chmodSync(command, 0o755);
        env[envKey] = command;
      }
      for (const [, envKey] of providers) vi.stubEnv(envKey, env[envKey]!);
      vi.stubEnv("AGENT_BRIDGE_PROVIDER_QUALIFICATION_PATH", evidencePath);
      for (const [provider] of providers) {
        const runtime = resolveProviderRuntime(provider, env);
        writeQualificationRecord({
          provider,
          executionRuntime: runtime.runtimeIdentity,
          providerVersion: runtime.selectedVersion!,
          previousVersion: null,
          bridgeCommit: "e".repeat(40),
          contractVersion: PROVIDER_CONTRACT_VERSION,
          qualifiedAt: "2026-10-01T00:00:00.000Z",
          environment: "managed-appliance",
          overall: "fail",
          checks: [{ name: "fresh_prompt", status: "fail", diagnostic: "contract drift" }],
        }, evidencePath);
      }

      expect([...getQualificationFailedProviders()]).toEqual(providers.map(([provider]) => provider));
      const available = getAvailableCliKinds({
        homeDir: root,
        env,
        exists: () => true,
        commandExists: (command) => Object.values(env).includes(command),
        agyRuntimeReady: () => true,
        readCursorStatus: () => ({ isAuthenticated: true }),
        readCursorVersion: () => "2026.09.23-86fc751",
      });

      expect([...available]).toEqual(["codex", "claude", "antigravity", "grok", "cursor"]);
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("tracks current passing Grok evidence for health and diagnostics", () => {
    const root = mkdtempSync(join(tmpdir(), "qualification-routing-grok-pass-"));
    const evidencePath = join(root, "qualification.json");
    const runtimeIdentity = resolveProviderRuntime("grok").runtimeIdentity;
    writeQualificationRecord({
      provider: "grok",
      executionRuntime: runtimeIdentity,
      providerVersion: "1.0.41",
      previousVersion: null,
      bridgeCommit: "e".repeat(40),
      contractVersion: PROVIDER_CONTRACT_VERSION,
      qualifiedAt: "2026-08-23T18:00:00.000Z",
      environment: "managed-appliance",
      overall: "degraded",
      checks: [
        { name: "version", status: "pass" },
        { name: "fresh_prompt", status: "not_authenticated" },
        { name: "session_resume", status: "not_applicable" },
      ],
    }, evidencePath);

    expect([...getQualificationPassedProviders(evidencePath, { grok: "1.0.41" })]).toEqual([]);

    writeQualificationRecord({
      provider: "grok",
      executionRuntime: runtimeIdentity,
      providerVersion: "1.0.41",
      previousVersion: null,
      bridgeCommit: "e".repeat(40),
      contractVersion: PROVIDER_CONTRACT_VERSION,
      qualifiedAt: "2026-08-23T18:01:00.000Z",
      environment: "managed-appliance",
      overall: "pass",
      checks: [
        { name: "version", status: "pass" },
        { name: "fresh_prompt", status: "pass" },
        { name: "session_resume", status: "pass" },
      ],
    }, evidencePath);

    expect([...getQualificationPassedProviders(evidencePath, { grok: "1.0.41" })]).toEqual(["grok"]);
    expect([...getQualificationPassedProviders(evidencePath, { grok: "1.0.31" })]).toEqual([]);
  });

  it("excludes providers with direct runtime exclusions from interactive selection", () => {
    const available = getAvailableCliKinds({
      agyRuntimeReady: () => true,
      homeDir: "/qualification-test-home",
      exists: () => true,
      commandExists: () => true,
      failedProviders: new Set(["codex", "agy"]),
      readCursorStatus: () => ({ isAuthenticated: true }),
      readCursorVersion: () => "2026.09.23-86fc751",
    });

    expect([...available]).toEqual(["claude", "grok", "cursor"]);
  });

  it("excludes Agy from interactive selection when its local harness is unavailable", () => {
    const available = getAvailableCliKinds({
      agyRuntimeReady: () => false,
      homeDir: "/qualification-test-home",
      exists: () => true,
      commandExists: () => true,
      failedProviders: new Set(["codex", "grok", "cursor"]),
      readCursorStatus: () => ({ isAuthenticated: true }),
      readCursorVersion: () => "2026.09.23-86fc751",
    });

    expect([...available]).toEqual(["claude"]);
  });

  it("excludes Grok from interactive selection when it has a runtime exclusion", () => {
    const available = getAvailableCliKinds({
      agyRuntimeReady: () => true,
      homeDir: "/qualification-test-home",
      exists: () => true,
      commandExists: () => true,
      failedProviders: new Set(["codex", "agy", "grok"]),
      readCursorStatus: () => ({ isAuthenticated: true }),
      readCursorVersion: () => "2026.09.23-86fc751",
    });

    expect([...available]).toEqual(["claude", "cursor"]);
  });

  it("excludes Cursor from interactive selection when it has a runtime exclusion", () => {
    const available = getAvailableCliKinds({
      agyRuntimeReady: () => true,
      homeDir: "/qualification-test-home",
      exists: () => true,
      commandExists: () => true,
      failedProviders: new Set(["codex", "agy", "grok", "cursor"]),
      readCursorStatus: () => ({ isAuthenticated: true }),
    });

    expect([...available]).toEqual(["claude"]);
  });

  it("uses canonical interactive availability to exclude Agy from fallback when its managed harness is unavailable", () => {
    vi.stubEnv("ANTIGRAVITY_HARNESS_PATH", "/definitely/missing/agy_localharness_external");
    try {
      const db = openDb(":memory:");
      const available = getAvailableCliKinds({
        homeDir: "/qualification-test-home",
        exists: () => true,
        commandExists: () => true,
        failedProviders: new Set(),
        readCursorStatus: () => ({ isAuthenticated: false }),
      });
      const chain = new ProviderFallbackChain(
        ["antigravity"],
        db,
        (cli) => available.has(cli as any),
      );
      expect(available.has("antigravity")).toBe(false);
      expect(chain.getChain()).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("skips unavailable providers when advancing the fallback chain", () => {
    const db = openDb(":memory:");
    const chain = new ProviderFallbackChain(
      ["codex", "claude", "antigravity"],
      db,
      (cli) => cli !== "claude",
    );

    expect(chain.getChain()).toEqual(["codex", "antigravity"]);
    expect(chain.getActiveCli("chat:1")).toBe("codex");
    expect(chain.advance("chat:1")).toBe("antigravity");
    expect(chain.isChainExhausted("chat:1")).toBe(true);
  });

  it("moves the effective active provider past an unavailable chain head without retrying it", () => {
    const db = openDb(":memory:");
    const chain = new ProviderFallbackChain(
      ["codex", "claude", "antigravity"],
      db,
      (cli) => cli !== "codex",
    );

    expect(chain.getActiveCli("chat:1")).toBe("claude");
    expect(chain.getChain()).toEqual(["claude", "antigravity"]);
    expect(chain.advance("chat:1")).toBe("antigravity");
  });
});
