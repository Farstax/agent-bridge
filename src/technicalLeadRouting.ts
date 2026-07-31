import { assertChainSupportsProfile } from "./advisorPolicy.js";
import type { AdvisorConfig, AdvisorTarget } from "./advisorTypes.js";
import type { RoleAssignmentConfig } from "./agentRoles.js";

export function isTechnicalLeadApproval(decision: "approve" | "reject" | undefined): boolean {
  if (decision === undefined) throw new Error("Technical Lead decision is required: expected approve or reject");
  return decision === "approve";
}

/** Build the read-only advisor configuration from the persisted Technical Lead assignment. */
export function resolveTechnicalLeadAdvisorConfig(
  base: AdvisorConfig,
  roleConfig: RoleAssignmentConfig | null,
  enabled: boolean,
): AdvisorConfig | null {
  if (!enabled) return null;
  const assignment = roleConfig?.assignments.find(({ role }) => role === "technical_lead");
  if (!assignment) throw new Error("Technical Lead routing enabled without a configured Technical Lead assignment");

  const targets: AdvisorTarget[] = [assignment.primary, ...assignment.fallbacks].map((target) => ({
    provider: target.cli === "antigravity" ? "agy" : target.cli as AdvisorTarget["provider"],
    model: target.model,
  }));
  // Do not fall back to the general advisor chain if a configured role target is unusable.
  assertChainSupportsProfile(targets, "tool_free");
  return { ...base, enabled: true, chain: targets };
}
