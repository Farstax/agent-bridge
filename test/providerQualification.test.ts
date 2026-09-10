import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PROVIDER_CONTRACT_VERSION,
  currentQualificationRuntime,
  isQualificationCurrent,
  qualificationHealthCheck,
  qualifyProvider,
  readProviderVersion,
  readQualificationEvidence,
  writeQualificationRecord,
  type ProviderQualificationRecord,
} from "../src/providers/qualification.js";
import { resolveProviderRuntime } from "../src/providers/acpRuntime.js";

type GroundingMode = "pass" | "omit_instruction" | "omit_source" | "capacity";

function executable(path: string, body: string, groundingMode: GroundingMode = "pass"): string {
  const groundingAction = groundingMode === "capacity"
    ? 'echo "usage limit reached" >&2\nexit 1'
    : `response="${groundingMode === "omit_instruction" ? "$fact" : groundingMode === "omit_source" ? "$marker" : "$fact $marker"}"
provider="$(basename "$0")"
case "$provider" in
  codex)
    printf '%s\\n' '{"type":"thread.started","thread_id":"11111111-2222-3333-4444-555555555555"}'
    printf '{"type":"item.completed","item":{"type":"agent_message","text":"%s"}}\\n' "$response"
    ;;
  claude)
    printf '{"result":"%s","session_id":"11111111-2222-3333-4444-555555555555"}\\n' "$response"
    ;;
  agy)
    printf '{"event":"result","result":{"conversation_id":"11111111-2222-3333-4444-555555555555","status":"SUCCESS","response":"%s"}}\\n' "$response"
    ;;
  grok)
    printf '{"type":"text","data":"%s"}\\n' "$response"
    printf '%s\\n' '{"type":"end","sessionId":"11111111-2222-3333-4444-555555555555","stopReason":"end_turn"}'
    ;;
  cursor-agent|cursor)
    printf '{"type":"result","subtype":"success","is_error":false,"result":"%s","session_id":"11111111-2222-3333-4444-555555555555"}\\n' "$response"
    ;;
  *) echo "unsupported fake provider" >&2; exit 99 ;;
esac
exit 0`;
  const groundingPrelude = `
if [[ " $* " == *"Agent Bridge repository-grounding qualification."* ]]; then
  if [[ " $* " == *"AGENT_BRIDGE_GROUNDING_FACT_"* || " $* " == *"AGENT_BRIDGE_GROUNDING_INSTRUCTION_"* ]]; then
    echo "grounding markers leaked into prompt" >&2
    exit 95
  fi
  if [[ " $* " == *" --disable shell_tool "* || " $* " == *" --tools "* ]]; then
    echo "native repository tools disabled during grounding probe" >&2
    exit 96
  fi
  fact="$(grep -o 'AGENT_BRIDGE_GROUNDING_FACT_[A-Za-z0-9]*' src/repositoryGroundingFixture.ts | head -n1)"
  marker="$(grep -o 'AGENT_BRIDGE_GROUNDING_INSTRUCTION_[A-Za-z0-9]*' AGENTS.md | head -n1)"
  [[ -n "$fact" && -n "$marker" ]] || { echo "grounding fixture unavailable" >&2; exit 97; }
  ${groundingAction}
fi
`;
  writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${groundingPrelude}\n${body}`, { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

type TestProvider = "codex" | "claude" | "agy" | "grok" | "cursor";

function passingProviderBody(provider: TestProvider): string {
  const version = provider === "codex" ? "codex-cli 9.9.9"
    : provider === "claude" ? "Claude Code 2.3.4"
    : provider === "agy" ? "agy 1.1.12"
    : provider === "grok" ? "grok 1.2.3"
    : "cursor-agent 1.2.3";
  const session = "11111111-2222-3333-4444-555555555555";
  const success = provider === "codex"
    ? `printf '%s\\n' '{"type":"thread.started","thread_id":"${session}"}'\nprintf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"native protocol response"}}'`
    : provider === "claude"
      ? `printf '%s\\n' '{"result":"native protocol response","session_id":"${session}"}'`
      : provider === "agy"
        ? `printf '%s\\n' '{"event":"result","result":{"conversation_id":"${session}","status":"SUCCESS","response":"native protocol response"}}'`
        : provider === "grok"
          ? `printf '%s\\n' '{"type":"text","data":"native protocol response"}'\nprintf '%s\\n' '{"type":"end","sessionId":"${session}","stopReason":"end_turn"}'`
          : `printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":"native protocol response","session_id":"${session}"}'`;
  return `if [[ "\${1:-}" == "--version" ]]; then echo "${version}"; exit 0; fi\n${success}`;
}

function passingRecord(overrides: Partial<ProviderQualificationRecord> = {}): ProviderQualificationRecord {
  return {
    provider: "codex",
    providerVersion: "9.9.9",
    previousVersion: "9.9.8",
    bridgeCommit: "a".repeat(40),
    contractVersion: PROVIDER_CONTRACT_VERSION,
    qualifiedAt: "2026-08-10T17:00:00.000Z",
    environment: "managed-appliance",
    executionRuntime: "acp",
    overall: "pass",
    checks: [
      { name: "version", status: "pass", diagnostic: "codex-cli 9.9.9" },
      { name: "fresh_prompt", status: "pass" },
      { name: "session_resume", status: "pass" },
      { name: "repository_grounding", status: "pass" },
    ],
    ...overrides,
  };
}

describe("provider qualification contract", () => {
  it("fails closed when Agy stream-json terminal ERROR includes a partial response on nonzero exit", async () => {
    const root = mkdtempSync(join(tmpdir(), "provider-qualification-agy-"));
    const evidencePath = join(root, "qualification.json");
    const fake = executable(join(root, "agy"), `
if [[ "\${1:-}" == "--version" ]]; then
  echo "agy 1.1.12"
  exit 0
fi
printf '%s\\n' '{"event":"result","result":{"conversation_id":"11111111-2222-3333-4444-555555555555","status":"ERROR","response":"partial response","error":"timed out waiting for idle"}}'
exit 1
`);

    const result = await qualifyProvider({
      providerId: "agy",
      executable: fake,
      evidencePath,
      bridgeCommit: "b".repeat(40),
      cwd: root,
      homeDir: root,
      timeoutMs: 5_000,
    });

    expect(result.overall).toBe("fail");
    expect(result.checks.find((check) => check.name === "fresh_prompt")).toMatchObject({
      status: "fail",
      diagnostic: expect.stringMatching(/ERROR result included a response/i),
    });
    expect(result.checks.find((check) => check.name === "session_resume")?.status).toBe("not_applicable");
  });

  it("treats authentication prerequisites as degraded rather than a provider contract failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "provider-qualification-auth-"));
    const evidencePath = join(root, "qualification.json");
    const fake = executable(join(root, "claude"), `
if [[ "\${1:-}" == "--version" ]]; then
  echo "2.3.4"
  exit 0
fi
echo "Authentication required. Please log in." >&2
exit 1
`);

    const result = await qualifyProvider({
      providerId: "claude",
      executable: fake,
      evidencePath,
      bridgeCommit: "c".repeat(40),
      cwd: root,
      homeDir: root,
      timeoutMs: 5_000,
    });

    expect(result.overall).toBe("degraded");
    expect(result.checks.find((check) => check.name === "fresh_prompt")?.status).toBe("not_authenticated");
    expect(result.checks.find((check) => check.name === "session_resume")?.status).toBe("not_applicable");
  });

  it("only considers evidence current for the same provider version, contract version and exact runtime identity", () => {
    const runtimeIdentity = currentQualificationRuntime("codex");
    const current = passingRecord({
      provider: "codex",
      providerVersion: "1.10.0",
      executionRuntime: runtimeIdentity,
    });
    expect(isQualificationCurrent(current, "codex", "1.10.0")).toBe(true);
    expect(isQualificationCurrent({ ...current, executionRuntime: "legacy" }, "codex", "1.10.0")).toBe(false);
    // A different distribution/version identity for the same version string must not qualify.
    expect(isQualificationCurrent({ ...current, executionRuntime: `${runtimeIdentity}-changed` }, "codex", "1.10.0")).toBe(false);
    expect(isQualificationCurrent(current, "codex", "1.10.1")).toBe(false);
    expect(isQualificationCurrent({ ...current, contractVersion: PROVIDER_CONTRACT_VERSION + 1 }, "codex", "1.10.0")).toBe(false);
    expect(isQualificationCurrent({ ...current, provider: "claude" }, "codex", "1.10.0")).toBe(false);
  });

  it("only considers native (non-ACP) evidence current for the resolved runtime identity", () => {
    const current = passingRecord({
      provider: "claude",
      providerVersion: "2.1.229",
      executionRuntime: "native:claude",
    });
    expect(isQualificationCurrent(current, "claude", "2.1.229")).toBe(true);
    expect(isQualificationCurrent({ ...current, executionRuntime: "native:codex" }, "claude", "2.1.229")).toBe(false);
    expect(isQualificationCurrent(current, "claude", "2.1.230")).toBe(false);
  });

  it("versions the Codex ACP executable used by production", async () => {
    const root = mkdtempSync(join(tmpdir(), "provider-qualification-acp-version-"));
    const previousCommand = process.env.CODEX_ACP_COMMAND;
    const previousArgs = process.env.CODEX_ACP_ARGS;
    const acp = executable(join(root, "codex-acp"), `
if [[ "\${1:-}" == "--version" ]]; then echo "@agentclientprotocol/codex-acp 1.10.0"; exit 0; fi
echo "acp should not be oneshot-parsed" >&2
exit 7
`);
    const legacy = executable(join(root, "codex"), passingProviderBody("codex"));
    process.env.CODEX_ACP_COMMAND = acp;
    delete process.env.CODEX_ACP_ARGS;
    try {
      const result = await qualifyProvider({
        providerId: "codex",
        executable: legacy,
        evidencePath: join(root, "qualification.json"),
        bridgeCommit: "a".repeat(40),
        cwd: root,
        homeDir: root,
        timeoutMs: 5_000,
        env: {
          ...process.env,
          CODEX_ACP_COMMAND: acp,
        },
      });
      expect(result.executionRuntime).toBe(resolveProviderRuntime("codex", {
        ...process.env,
        CODEX_ACP_COMMAND: acp,
      }).runtimeIdentity);
      expect(result.providerVersion).toBe("1.10.0");
      expect(result.checks.find((check) => check.name === "version")?.diagnostic).toMatch(/codex-acp 1\.10\.0/);
    } finally {
      if (previousCommand === undefined) delete process.env.CODEX_ACP_COMMAND;
      else process.env.CODEX_ACP_COMMAND = previousCommand;
      if (previousArgs === undefined) delete process.env.CODEX_ACP_ARGS;
      else process.env.CODEX_ACP_ARGS = previousArgs;
    }
  });

  it("reports the observed version of a wrongly installed ACP adapter instead of throwing", async () => {
    const root = mkdtempSync(join(tmpdir(), "provider-qualification-acp-version-drift-"));
    const previousCommand = process.env.CODEX_ACP_COMMAND;
    const wrongVersion = executable(join(root, "codex-acp"), `
if [[ "\${1:-}" == "--version" ]]; then echo "@agentclientprotocol/codex-acp 0.141.0"; exit 0; fi
exit 7
`);
    process.env.CODEX_ACP_COMMAND = wrongVersion;
    try {
      // A passive version observation (used by health/doctor consumers) must
      // report what is actually installed, not fail closed the way an
      // active qualification run does — otherwise a real "wrong version
      // installed" diagnostic gets misreported as "executable not found".
      expect(readProviderVersion("codex", undefined, {
        ...process.env,
        CODEX_ACP_COMMAND: wrongVersion,
      })).toBe("0.141.0");
    } finally {
      if (previousCommand === undefined) delete process.env.CODEX_ACP_COMMAND;
      else process.env.CODEX_ACP_COMMAND = previousCommand;
    }
  });

  it("does not require tool-free execution for ACP Codex fresh_prompt qualification", async () => {
    const root = mkdtempSync(join(tmpdir(), "provider-qualification-acp-toolfree-"));
    const previousCommand = process.env.CODEX_ACP_COMMAND;
    const previousArgs = process.env.CODEX_ACP_ARGS;
    const fakeAgent = fileURLToPath(new URL("./support/fakeAcpAgent.ts", import.meta.url));
    // Qualification always probes the resolved ACP runtime's own executable
    // for `--version` (never a test-only invocation override), so the
    // wrapper must answer the release-locked version itself before
    // delegating the actual ACP session to the fake agent.
    const wrapper = join(root, "codex-acp");
    writeFileSync(wrapper, `#!/usr/bin/env bash
if [ "\${1:-}" = "--version" ]; then echo "@agentclientprotocol/codex-acp 1.10.0"; exit 0; fi
exec "${process.execPath}" "${join(process.cwd(), "node_modules/tsx/dist/cli.mjs")}" "${fakeAgent}"
`);
    chmodSync(wrapper, 0o755);
    process.env.CODEX_ACP_COMMAND = wrapper;
    delete process.env.CODEX_ACP_ARGS;
    try {
      const result = await qualifyProvider({
        providerId: "codex",
        evidencePath: join(root, "qualification.json"),
        bridgeCommit: "d".repeat(40),
        cwd: root,
        homeDir: root,
        timeoutMs: 5_000,
        env: {
          ...process.env,
          CODEX_ACP_COMMAND: wrapper,
        },
      });
      const freshPrompt = result.checks.find((check) => check.name === "fresh_prompt");
      expect(freshPrompt?.status).toBe("pass");
      expect(freshPrompt?.diagnostic ?? "").not.toMatch(/tool-free/i);
    } finally {
      if (previousCommand === undefined) delete process.env.CODEX_ACP_COMMAND;
      else process.env.CODEX_ACP_COMMAND = previousCommand;
      if (previousArgs === undefined) delete process.env.CODEX_ACP_ARGS;
      else process.env.CODEX_ACP_ARGS = previousArgs;
    }
  }, 15_000);

  it("observes the active executable before reusing qualification evidence", async () => {
    const root = mkdtempSync(join(tmpdir(), "provider-qualification-runtime-version-"));
    const evidencePath = join(root, "qualification.json");
    writeQualificationRecord(passingRecord({
      provider: "claude",
      providerVersion: "2.1.229",
    }), evidencePath);
    const fake = executable(join(root, "claude"), `
if [[ "\${1:-}" == "--version" ]]; then
  echo "Claude Code 2.1.228"
  exit 0
fi
printf '%s\\n' '{"result":"AGENT_BRIDGE_QUALIFICATION_OK","session_id":"session-1"}'
`);

    const result = await import("../src/providers/qualification.js").then(({ qualifyProviderIfNeeded }) =>
      qualifyProviderIfNeeded({
        providerId: "claude",
        executable: fake,
        installedVersion: "2.1.229",
        evidencePath,
        bridgeCommit: "f".repeat(40),
        cwd: root,
        homeDir: root,
        timeoutMs: 5_000,
      }));

    expect(result.ran).toBe(true);
    expect(result.record.providerVersion).toBe("2.1.228");
    expect(readQualificationEvidence(evidencePath).providers.claude?.providerVersion).toBe("2.1.228");
  });

  it("reuses cached evidence only when the active executable version agrees", async () => {
    const root = mkdtempSync(join(tmpdir(), "provider-qualification-runtime-cache-"));
    const evidencePath = join(root, "qualification.json");
    const fake = executable(join(root, "claude"), `
if [[ "\${1:-}" == "--version" ]]; then
  echo "Claude Code 2.1.229"
  exit 0
fi
exit 1
`);
    const cached = passingRecord({
      provider: "claude",
      providerVersion: "2.1.229",
      executionRuntime: "native:claude",
    });
    writeQualificationRecord(cached, evidencePath);

    const { qualifyProviderIfNeeded } = await import("../src/providers/qualification.js");
    const result = await qualifyProviderIfNeeded({
      providerId: "claude",
      executable: fake,
      installedVersion: "2.1.229",
      evidencePath,
      bridgeCommit: "f".repeat(40),
      cwd: root,
      homeDir: root,
      timeoutMs: 5_000,
    });

    expect(result.ran).toBe(false);
    expect(result.record).toEqual(cached);
  });

  it("surfaces persistent pass, degraded and unqualified states for health without rerunning tests", () => {
    const root = mkdtempSync(join(tmpdir(), "provider-qualification-health-"));
    const evidencePath = join(root, "qualification.json");
    const nativeRecord = (overrides: Partial<ProviderQualificationRecord> = {}) => passingRecord({
      provider: "claude",
      providerVersion: "9.9.9",
      executionRuntime: "native:claude",
      ...overrides,
    });
    writeQualificationRecord(nativeRecord(), evidencePath);

    expect(qualificationHealthCheck("claude", "9.9.9", evidencePath)).toMatchObject({
      status: "green",
      message: expect.stringContaining("qualified"),
    });

    writeQualificationRecord(nativeRecord({
      overall: "fail",
      checks: [
        { name: "version", status: "pass" },
        { name: "fresh_prompt", status: "fail", diagnostic: "JSON envelope drift" },
        { name: "session_resume", status: "not_applicable" },
      ],
    }), evidencePath);
    expect(qualificationHealthCheck("claude", "9.9.9", evidencePath)).toMatchObject({
      status: "red",
      message: expect.stringMatching(/degraded.*fresh_prompt/i),
    });

    expect(qualificationHealthCheck("claude", "9.9.10", evidencePath)).toMatchObject({
      status: "amber",
      message: expect.stringMatching(/9\.9\.10.*unqualified/i),
    });
  });

  it("accepts native Claude result/session evidence without semantic marker prose", async () => {
    const root = mkdtempSync(join(tmpdir(), "provider-qualification-native-claude-"));
    const fake = executable(join(root, "claude"), `
if [[ "\${1:-}" == "--version" ]]; then echo "Claude Code 2.3.4"; exit 0; fi
printf '%s\\n' '{"result":"native protocol response","session_id":"11111111-2222-3333-4444-555555555555"}'
`);

    const result = await qualifyProvider({
      providerId: "claude",
      executable: fake,
      evidencePath: join(root, "qualification.json"),
      bridgeCommit: "4".repeat(40),
      cwd: root,
      homeDir: root,
      timeoutMs: 5_000,
    });

    expect(result.overall).toBe("pass");
    expect(result.checks.find((check) => check.name === "session_resume")?.status).toBe("pass");
  });

  it("accepts strict Agy stream-json conversation evidence without semantic marker prose", async () => {
    const root = mkdtempSync(join(tmpdir(), "provider-qualification-native-agy-"));
    const fake = executable(join(root, "agy"), `
if [[ "\${1:-}" == "--version" ]]; then echo "agy 1.1.12"; exit 0; fi
printf '%s\\n' '{"event":"result","result":{"conversation_id":"11111111-2222-3333-4444-555555555555","status":"SUCCESS","response":"native protocol response"}}'
`);

    const result = await qualifyProvider({
      providerId: "agy",
      executable: fake,
      evidencePath: join(root, "qualification.json"),
      bridgeCommit: "4".repeat(40),
      cwd: root,
      homeDir: root,
      timeoutMs: 5_000,
    });

    expect(result.overall).toBe("pass");
    expect(result.checks.find((check) => check.name === "session_resume")?.status).toBe("pass");
  });

  it("fails closed when a required native session identity is missing", async () => {
    const root = mkdtempSync(join(tmpdir(), "provider-qualification-native-missing-session-"));
    const fake = executable(join(root, "claude"), `
if [[ "\${1:-}" == "--version" ]]; then echo "Claude Code 2.3.4"; exit 0; fi
if [[ " $* " == *"Agent Bridge repository-grounding qualification."* ]]; then
  fact="$(grep -o 'AGENT_BRIDGE_GROUNDING_FACT_[A-Za-z0-9]*' src/repositoryGroundingFixture.ts | head -n1)"
  marker="$(grep -o 'AGENT_BRIDGE_GROUNDING_INSTRUCTION_[A-Za-z0-9]*' AGENTS.md | head -n1)"
  printf '%s\\n' '{"result":"'"$fact $marker"'"}'
  exit 0
fi
printf '%s\\n' '{"result":"native protocol response"}'
`);

    const result = await qualifyProvider({
      providerId: "claude",
      executable: fake,
      evidencePath: join(root, "qualification.json"),
      bridgeCommit: "4".repeat(40),
      cwd: root,
      homeDir: root,
      timeoutMs: 5_000,
    });

    expect(result.overall).toBe("pass");
    expect(result.checks.find((check) => check.name === "fresh_prompt")).toMatchObject({
      status: "pass",
    });
    expect(result.checks.find((check) => check.name === "session_resume")?.status).toBe("not_applicable");
    expect(result.checks.find((check) => check.name === "repository_grounding")?.status).toBe("pass");
  });

  it("fails closed on malformed provider-native envelopes", async () => {
    const root = mkdtempSync(join(tmpdir(), "provider-qualification-native-malformed-"));
    const fake = executable(join(root, "agy"), `
if [[ "\${1:-}" == "--version" ]]; then echo "agy 1.1.12"; exit 0; fi
printf '%s\\n' '{not-json'
`);

    const result = await qualifyProvider({
      providerId: "agy",
      executable: fake,
      evidencePath: join(root, "qualification.json"),
      bridgeCommit: "4".repeat(40),
      cwd: root,
      homeDir: root,
      timeoutMs: 5_000,
    });

    expect(result.overall).toBe("fail");
    expect(result.checks.find((check) => check.name === "fresh_prompt")).toMatchObject({
      status: "fail",
      diagnostic: expect.stringMatching(/native result parsing|stream JSON parse failed/i),
    });
  });

  it.each(["claude", "agy", "grok", "cursor"] as const)(
    "runs repository-grounding qualification with native tools for %s",
    async (provider) => {
      const root = mkdtempSync(join(tmpdir(), `provider-grounding-${provider}-`));
      const command = provider === "cursor" ? "cursor-agent" : provider;
      const fake = executable(join(root, command), passingProviderBody(provider));
      const result = await qualifyProvider({
        providerId: provider,
        executable: fake,
        evidencePath: join(root, "qualification.json"),
        bridgeCommit: "6".repeat(40),
        cwd: root,
        homeDir: root,
        timeoutMs: 5_000,
      });
      expect(result.overall).toBe("pass");
      expect(result.checks.find((check) => check.name === "repository_grounding")).toEqual({
        name: "repository_grounding",
        status: "pass",
      });
    },
  );

  it("fails repository grounding when the native answer omits the repository instruction marker", async () => {
    const root = mkdtempSync(join(tmpdir(), "provider-grounding-omission-"));
    const fake = executable(join(root, "claude"), passingProviderBody("claude"), "omit_instruction");
    const result = await qualifyProvider({
      providerId: "claude",
      executable: fake,
      evidencePath: join(root, "qualification.json"),
      bridgeCommit: "7".repeat(40),
      cwd: root,
      homeDir: root,
      timeoutMs: 5_000,
    });
    expect(result.overall).toBe("fail");
    expect(result.checks.find((check) => check.name === "repository_grounding")).toMatchObject({
      status: "fail",
      diagnostic: expect.stringMatching(/repository instruction marker/i),
    });
  });

  it("fails repository grounding when the native answer returns the wrong source fact", async () => {
    const root = mkdtempSync(join(tmpdir(), "provider-grounding-wrong-source-"));
    const fake = executable(join(root, "claude"), passingProviderBody("claude"), "omit_source");
    const result = await qualifyProvider({
      providerId: "claude",
      executable: fake,
      evidencePath: join(root, "qualification.json"),
      bridgeCommit: "9".repeat(40),
      cwd: root,
      homeDir: root,
      timeoutMs: 5_000,
    });
    expect(result.overall).toBe("fail");
    expect(result.checks.find((check) => check.name === "repository_grounding")).toMatchObject({
      status: "fail",
      diagnostic: expect.stringMatching(/source fact/i),
    });
  });

  it("keeps provider capacity exhaustion distinct from a deterministic grounding failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "provider-grounding-capacity-"));
    const fake = executable(join(root, "claude"), passingProviderBody("claude"), "capacity");
    const result = await qualifyProvider({
      providerId: "claude",
      executable: fake,
      evidencePath: join(root, "qualification.json"),
      bridgeCommit: "8".repeat(40),
      cwd: root,
      homeDir: root,
      timeoutMs: 5_000,
    });
    expect(result.overall).toBe("degraded");
    expect(result.checks.find((check) => check.name === "repository_grounding")).toMatchObject({
      status: "capacity_exhausted",
      diagnostic: expect.stringMatching(/usage limit/i),
    });
  });

});
