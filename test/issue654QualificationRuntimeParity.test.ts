import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildQualificationInvocation,
  buildQualificationSupervisorOptions,
  resolveQualificationRuntimePolicy,
} from "../src/providers/qualification.js";
import { resolveQualificationEntrypointEnvironment } from "../src/providers/qualificationEntrypoint.js";
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

  it("qualification entrypoint uses provider service env instead of caller policy", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-provider-entrypoint-env-"));
    writeFileSync(join(root, "agent-bridge-shared"), "BRIDGE_EXECUTION_MODE=safe\nCLI_TIMEOUT_MS=1000\nCLI_IDLE_TIMEOUT_MS=2000\n");
    writeFileSync(join(root, "agent-bridge-release"), "BRIDGE_EXECUTION_MODE=safe\nCLI_TIMEOUT_MS=3000\nCLI_IDLE_TIMEOUT_MS=3500\n");
    writeFileSync(join(root, "agent-bridge-antigravity"), "ANTIGRAVITY_EXECUTION_MODE=trusted\nANTIGRAVITY_CLI_TIMEOUT_MS=3600000\nANTIGRAVITY_CLI_IDLE_TIMEOUT_MS=180000\n");

    const env = resolveQualificationEntrypointEnvironment("agy", {
      directory: root,
      ambientEnv: {
        HOME: "/tmp/home",
        PATH: "/usr/bin",
        BRIDGE_EXECUTION_MODE: "trusted",
        ANTIGRAVITY_EXECUTION_MODE: "safe",
        ANTIGRAVITY_CLI_TIMEOUT_MS: "7",
        ANTIGRAVITY_CLI_IDLE_TIMEOUT_MS: "9",
      },
    });

    expect(resolveQualificationRuntimePolicy("agy", env)).toEqual({
      executionMode: "trusted",
      timeoutMs: 3_600_000,
      idleTimeoutMs: 180_000,
    });
    expect(env.HOME).toBe("/tmp/home");
  });

  it("uses the same ordered environment files as the deployed provider services", () => {
    for (const [provider, service] of [["codex", "codex"], ["agy", "antigravity"]] as const) {
      const unit = readFileSync(`systemd/agent-bridge-${service}.service`, "utf8");
      const unitFiles = unit.split("\n")
        .filter((line) => line.startsWith("EnvironmentFile="))
        .map((line) => ({
          path: line.replace(/^EnvironmentFile=-?/, ""),
          optional: line.startsWith("EnvironmentFile=-"),
        }));
      expect(providerRuntimeEnvironmentFiles(provider)).toEqual(unitFiles);
    }
  });

  it("wires the normal upgrade path through the service-environment qualification entrypoint", () => {
    const upgrade = readFileSync("scripts/upgrade.sh", "utf8");
    const entrypoint = readFileSync("scripts/provider-qualification.ts", "utf8");
    expect(upgrade).toContain("scripts/provider-qualification.ts");
    expect(upgrade).toContain("qualify_provider_if_needed codex");
    expect(upgrade).toContain("qualify_provider_if_needed agy");
    expect(entrypoint).toContain("resolveQualificationEntrypointEnvironment");
    expect(entrypoint).toContain("env: runtimeEnv");
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

  it("passes distinct hard and idle timeout values into qualification supervisor options", () => {
    expect(buildQualificationSupervisorOptions("agy", 3_600_000, 180_000)).toMatchObject({
      bot: "antigravity",
      timeoutMs: 3_600_000,
      idleTimeoutMs: 180_000,
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
