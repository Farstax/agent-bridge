import { describe, expect, it } from "vitest";
import { parseAdvisorConfig } from "../src/advisorConfig.js";
import { resolveTechnicalLeadAdvisorConfig } from "../src/technicalLeadRouting.js";
import type { RoleAssignmentConfig } from "../src/agentRoles.js";

const roleConfig: RoleAssignmentConfig = {
  scopeKey: "worker:test",
  source: "environment",
  status: "configured_dormant",
  idempotencyKey: "environment:test",
  assignments: [
    { role: "technical_lead", selection: "manual", primary: { cli: "claude", model: "lead-a" }, fallbacks: [{ cli: "codex", model: "lead-b" }] },
    { role: "code_worker", selection: "recommended", primary: { cli: "codex", model: "worker" }, fallbacks: [] },
    { role: "documentation_steward", selection: "automatic", primary: { cli: "antigravity", model: "docs" }, fallbacks: [] },
  ],
};

describe("Technical Lead routing", () => {
  it("is disabled by default and preserves the base advisor config", () => {
    const base = parseAdvisorConfig({ BRIDGE_ADVISOR_ENABLED: "true", BRIDGE_ADVISOR_CHAIN: "codex:generic" });

    expect(resolveTechnicalLeadAdvisorConfig(base, roleConfig, false)).toBeNull();
  });

  it("uses only the persisted Technical Lead primary and fallback order", () => {
    const base = parseAdvisorConfig({ BRIDGE_ADVISOR_ENABLED: "false" });

    expect(resolveTechnicalLeadAdvisorConfig(base, roleConfig, true)).toMatchObject({
      enabled: true,
      chain: [
        { provider: "claude", model: "lead-a" },
        { provider: "codex", model: "lead-b" },
      ],
    });
  });

  it("fails closed when enabled without a configured Technical Lead", () => {
    const base = parseAdvisorConfig({});

    expect(() => resolveTechnicalLeadAdvisorConfig(base, null, true)).toThrow(/technical lead/i);
  });
});
