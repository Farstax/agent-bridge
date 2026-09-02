import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildQualificationInvocation,
  resolveQualificationRuntimePolicy,
} from "../src/providers/qualification.js";
import {
  loadProviderRuntimeEnvironment,
  providerRuntimeEnvironmentFiles,
} from "../src/providers/runtimeEnvironment.js";

describe("issue #654 qualification runtime parity", () => {
  it("loads shared, release, then provider-specific service environment", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-provider-env-"));
    writeFileSync(join(root, "agent-bridge-shared"), "BRIDGE_EXECUTION_MODE=safe\nCLI_TIMEOUT_MS=1000\nCLI_IDLE_TIMEOUT_MS=2000\n");
    writeFileSync(join(root, "agent-bridge-release"), "BRIDGE_EXECUTION_MODE=trusted\nCLI_TIMEOUT_MS=3000\n");
    writeFileSync(join(root, "agent-bridge-codex"), "CODEX_EXECUTION_MODE=safe\nCODEX_CLI_TIMEOUT_MS=4000\nCODEX_CLI_IDLE_TIMEOUT_MS=5000\n");

    const env = loadProviderRuntimeEnvironment("codex", { directory: root, baseEnv: {} });
    expect(resolveQualificationRuntimePolicy("codex", env)).toEqual({
      executionMode: "safe",
      timeoutMs: 4000,
      idleTimeoutMs: 5000,
    });
  });

  it("uses the same ordered environment files as the deployed provider services", () => {
    expect(providerRuntimeEnvironmentFiles("codex")).toEqual([
      { path: "/etc/default/agent-bridge-shared", optional: true },
      { path: "/etc/default/agent-bridge-release", optional: false },
      { path: "/etc/default/agent-bridge-codex", optional: false },
    ]);
    expect(providerRuntimeEnvironmentFiles("agy")[2]).toEqual({
      path: "/etc/default/agent-bridge-antigravity",
      optional: false,
    });
  });

  it("lets provider-specific execution mode override the global mode", () => {
    expect(resolveQualificationRuntimePolicy("agy", {
      BRIDGE_EXECUTION_MODE: "safe",
      ANTIGRAVITY_EXECUTION_MODE: "trusted",
    }).executionMode).toBe("trusted");
  });

  it("preserves distinct runtime hard and idle timeouts and explicit override precedence", () => {
    const env = {
      ANTIGRAVITY_CLI_TIMEOUT_MS: "3600000",
      ANTIGRAVITY_CLI_IDLE_TIMEOUT_MS: "180000",
    };
    expect(resolveQualificationRuntimePolicy("agy", env)).toMatchObject({
      timeoutMs: 3_600_000,
      idleTimeoutMs: 180_000,
    });
    expect(resolveQualificationRuntimePolicy("agy", env, 5000, 7000)).toMatchObject({
      timeoutMs: 5000,
      idleTimeoutMs: 7000,
    });
  });

  it("generates trusted Codex and Agy qualification flags while safe mode omits them", () => {
    const trustedCodex = buildQualificationInvocation({
      providerId: "codex", executable: "codex", prompt: "probe", sessionId: null,
      executionMode: "trusted", homeDir: "/tmp",
    });
    expect(trustedCodex.args).toContain("--dangerously-bypass-approvals-and-sandbox");

    const safeCodex = buildQualificationInvocation({
      providerId: "codex", executable: "codex", prompt: "probe", sessionId: null,
      executionMode: "safe", homeDir: "/tmp",
    });
    expect(safeCodex.args).not.toContain("--dangerously-bypass-approvals-and-sandbox");

    const trustedAgy = buildQualificationInvocation({
      providerId: "agy", executable: "agy", prompt: "probe", sessionId: null,
      executionMode: "trusted", homeDir: "/tmp",
    });
    expect(trustedAgy.args).toContain("--dangerously-skip-permissions");

    const safeAgy = buildQualificationInvocation({
      providerId: "agy", executable: "agy", prompt: "probe", sessionId: null,
      executionMode: "safe", homeDir: "/tmp",
    });
    expect(safeAgy.args).not.toContain("--dangerously-skip-permissions");
  });
});
