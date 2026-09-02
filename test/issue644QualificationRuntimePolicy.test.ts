import { describe, expect, it } from "vitest";
import {
  PROVIDER_CONTRACT_VERSION,
  isQualificationCurrent,
  resolveQualificationRuntimePolicy,
  type ProviderQualificationRecord,
} from "../src/providers/qualification.js";

describe("issue #644 qualification runtime policy", () => {
  it("uses the same global execution-mode override as ordinary runtime", () => {
    expect(resolveQualificationRuntimePolicy("codex", {
      BRIDGE_EXECUTION_MODE: "trusted",
      CODEX_CLI_TIMEOUT_MS: "240000",
    })).toEqual({
      executionMode: "trusted",
      timeoutMs: 240_000,
    });
  });

  it("maps Agy to Antigravity per-provider execution mode and timeout", () => {
    expect(resolveQualificationRuntimePolicy("agy", {
      BRIDGE_EXECUTION_MODE: "safe",
      ANTIGRAVITY_EXECUTION_MODE: "trusted",
      ANTIGRAVITY_CLI_TIMEOUT_MS: "3600000",
    })).toEqual({
      executionMode: "trusted",
      timeoutMs: 3_600_000,
    });
  });

  it("keeps safe/no-timeout runtime defaults when no overrides exist", () => {
    expect(resolveQualificationRuntimePolicy("codex", {})).toEqual({
      executionMode: "safe",
      timeoutMs: 0,
    });
  });

  it("lets an explicit qualification timeout override runtime timeout configuration", () => {
    expect(resolveQualificationRuntimePolicy("agy", {
      BRIDGE_EXECUTION_MODE: "trusted",
      ANTIGRAVITY_CLI_TIMEOUT_MS: "3600000",
    }, 5_000)).toEqual({
      executionMode: "trusted",
      timeoutMs: 5_000,
    });
  });

  it("invalidates v4 evidence so corrected qualification runs again after upgrade", () => {
    const oldRecord: ProviderQualificationRecord = {
      provider: "codex",
      providerVersion: "9.9.9",
      previousVersion: null,
      bridgeCommit: "a".repeat(40),
      contractVersion: 4,
      qualifiedAt: "2026-09-02T00:00:00.000Z",
      environment: "managed-appliance",
      overall: "fail",
      checks: [
        { name: "version", status: "pass" },
        { name: "fresh_prompt", status: "pass" },
        { name: "session_resume", status: "pass" },
        { name: "repository_grounding", status: "fail" },
      ],
    };

    expect(PROVIDER_CONTRACT_VERSION).toBe(5);
    expect(isQualificationCurrent(oldRecord, "codex", "9.9.9")).toBe(false);
  });
});
