import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PROVIDER_CONTRACT_VERSION,
  isQualificationCurrent,
  qualificationHealthCheck,
  qualifyProvider,
  readQualificationEvidence,
  writeQualificationRecord,
  type ProviderQualificationRecord,
} from "../src/providers/qualification.js";

type GroundingMode = "pass" | "omit_instruction" | "capacity";

function executable(path: string, body: string, groundingMode: GroundingMode = "pass"): string {
  const groundingAction = groundingMode === "capacity"
    ? 'echo "usage limit reached" >&2\nexit 1'
    : `response="${groundingMode === "omit_instruction" ? "$fact" : "$fact $marker"}"
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
  if [[ " $* " == *" --disable shell_tool "* || " $* " == *" --tools "* || " $* " == *" --sandbox "* ]]; then
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
  it("qualifies a real fake Codex process for version, fresh prompt and resume and persists versioned evidence", async () => {
    const root = mkdtempSync(join(tmpdir(), "provider-qualification-codex-"));
    const evidencePath = join(root, "qualification.json");
    const fake = executable(join(root, "codex"), `
if [[ "\${1:-}" == "--version" ]]; then
  echo "codex-cli 9.9.9"
  exit 0
fi
if [[ " $* " == *" exec resume "* ]]; then
  printf '%s\\n' '{"type":"thread.started","thread_id":"11111111-2222-3333-4444-555555555555"}'
  printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"resumed native response"}}'
else
  printf '%s\\n' '{"type":"thread.started","thread_id":"11111111-2222-3333-4444-555555555555"}'
  printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"fresh native response"}}'
fi
`);

    const result = await qualifyProvider({
      providerId: "codex",
      executable: fake,
      evidencePath,
      previousVersion: "9.9.8",
      bridgeCommit: "a".repeat(40),
      cwd: root,
      homeDir: root,
      timeoutMs: 5_000,
    });

    expect(result.overall).toBe("pass");
    expect(result.providerVersion).toBe("9.9.9");
    expect(result.checks.map((check) => [check.name, check.status])).toEqual([
      ["version", "pass"],
      ["fresh_prompt", "pass"],
      ["session_resume", "pass"],
      ["repository_grounding", "pass"],
    ]);
    expect(readQualificationEvidence(evidencePath).providers.codex).toEqual(result);
    expect(JSON.parse(readFileSync(evidencePath, "utf8"))).toMatchObject({
      schemaVersion: 1,
      contractVersion: PROVIDER_CONTRACT_VERSION,
    });
  });

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

  it("keeps an authentication prerequisite during session resume degraded", async () => {
    const root = mkdtempSync(join(tmpdir(), "provider-qualification-resume-auth-"));
    const evidencePath = join(root, "qualification.json");
    const fake = executable(join(root, "codex"), `
if [[ "\${1:-}" == "--version" ]]; then
  echo "codex-cli 9.9.9"
  exit 0
fi
if [[ " $* " == *" exec resume "* ]]; then
  echo "Authentication required. Please log in." >&2
  exit 1
fi
printf '%s\\n' '{"type":"thread.started","thread_id":"11111111-2222-3333-4444-555555555555"}'
printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"AGENT_BRIDGE_QUALIFICATION_OK"}}'
`);

    const result = await qualifyProvider({
      providerId: "codex",
      executable: fake,
      evidencePath,
      bridgeCommit: "c".repeat(40),
      cwd: root,
      homeDir: root,
      timeoutMs: 5_000,
    });

    expect(result.overall).toBe("degraded");
    expect(result.checks.find((check) => check.name === "fresh_prompt")?.status).toBe("pass");
    expect(result.checks.find((check) => check.name === "session_resume")).toMatchObject({
      status: "not_authenticated",
      diagnostic: expect.stringMatching(/Authentication required/i),
    });
  });

  it("only considers evidence current for the same provider version and contract version", () => {
    const current = passingRecord();
    expect(isQualificationCurrent(current, "codex", "9.9.9")).toBe(true);
    expect(isQualificationCurrent(current, "codex", "9.9.10")).toBe(false);
    expect(isQualificationCurrent({ ...current, contractVersion: PROVIDER_CONTRACT_VERSION + 1 }, "codex", "9.9.9")).toBe(false);
    expect(isQualificationCurrent({ ...current, provider: "claude" }, "codex", "9.9.9")).toBe(false);
  });

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
    writeQualificationRecord(passingRecord(), evidencePath);

    expect(qualificationHealthCheck("codex", "9.9.9", evidencePath)).toMatchObject({
      status: "green",
      message: expect.stringContaining("qualified"),
    });

    writeQualificationRecord(passingRecord({
      overall: "fail",
      checks: [
        { name: "version", status: "pass" },
        { name: "fresh_prompt", status: "fail", diagnostic: "JSON envelope drift" },
        { name: "session_resume", status: "not_applicable" },
      ],
    }), evidencePath);
    expect(qualificationHealthCheck("codex", "9.9.9", evidencePath)).toMatchObject({
      status: "red",
      message: expect.stringMatching(/degraded.*fresh_prompt/i),
    });

    expect(qualificationHealthCheck("codex", "9.9.10", evidencePath)).toMatchObject({
      status: "amber",
      message: expect.stringMatching(/9\.9\.10.*unqualified/i),
    });
  });

  it("accepts native Codex result/session evidence without semantic marker prose", async () => {
    const root = mkdtempSync(join(tmpdir(), "provider-qualification-native-codex-"));
    const fake = executable(join(root, "codex"), `
if [[ "\${1:-}" == "--version" ]]; then echo "codex-cli 9.9.9"; exit 0; fi
printf '%s\\n' '{"type":"thread.started","thread_id":"11111111-2222-3333-4444-555555555555"}'
printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"native protocol response"}}'
`);

    const result = await qualifyProvider({
      providerId: "codex",
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

  it("fails resume compatibility when native session identity contradicts the resumed session", async () => {
    const root = mkdtempSync(join(tmpdir(), "provider-qualification-native-resume-"));
    const fake = executable(join(root, "codex"), `
if [[ "\${1:-}" == "--version" ]]; then echo "codex-cli 9.9.9"; exit 0; fi
if [[ " $* " == *" exec resume "* ]]; then
  printf '%s\\n' '{"type":"thread.started","thread_id":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"}'
  printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"resumed native response"}}'
else
  printf '%s\\n' '{"type":"thread.started","thread_id":"11111111-2222-3333-4444-555555555555"}'
  printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"fresh native response"}}'
fi
`);

    const result = await qualifyProvider({
      providerId: "codex",
      executable: fake,
      evidencePath: join(root, "qualification.json"),
      bridgeCommit: "4".repeat(40),
      cwd: root,
      homeDir: root,
      timeoutMs: 5_000,
    });

    expect(result.overall).toBe("fail");
    expect(result.checks.find((check) => check.name === "session_resume")).toMatchObject({
      status: "fail",
      diagnostic: expect.stringMatching(/resume compatibility.*session identity/i),
    });
  });

  it("fails closed when a required native session identity is missing", async () => {
    const root = mkdtempSync(join(tmpdir(), "provider-qualification-native-missing-session-"));
    const fake = executable(join(root, "claude"), `
if [[ "\${1:-}" == "--version" ]]; then echo "Claude Code 2.3.4"; exit 0; fi
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

    expect(result.overall).toBe("fail");
    expect(result.checks.find((check) => check.name === "fresh_prompt")).toMatchObject({
      status: "fail",
      diagnostic: expect.stringMatching(/session identity/i),
    });
    expect(result.checks.find((check) => check.name === "session_resume")?.status).toBe("not_applicable");
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

  it.each(["codex", "claude", "agy", "grok", "cursor"] as const)(
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
    const fake = executable(join(root, "codex"), passingProviderBody("codex"), "omit_instruction");
    const result = await qualifyProvider({
      providerId: "codex",
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

  it("keeps provider capacity exhaustion distinct from a deterministic grounding failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "provider-grounding-capacity-"));
    const fake = executable(join(root, "codex"), passingProviderBody("codex"), "capacity");
    const result = await qualifyProvider({
      providerId: "codex",
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
