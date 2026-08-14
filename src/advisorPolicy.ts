import type { AdvisorOrigin, AdvisorPolicyMode, AdvisorTarget } from "./advisorTypes.js";
import { supportsToolFreeMode } from "./providers/registry.js";
export function shouldAllowAdvisorCall(mode: AdvisorPolicyMode, origin: AdvisorOrigin, approved: boolean): boolean {
  if (origin === "manual") return true;
  if (origin === "suggest") return mode !== "manual" && approved;
  return mode === "auto";
}

// Every advisor entry point runs tool_free: the advisor model must not be able
// to execute tools. Only providers with a verified tool-disabled invocation
// qualify; the provider registry is the capability owner.
export type AdvisorExecutionProfile = "tool_free";
export function assertChainSupportsProfile(chain: AdvisorTarget[], profile: AdvisorExecutionProfile): void {
  if (profile !== "tool_free") throw new Error(`Unknown advisor execution profile: ${profile as string}`);
  const ineligible = chain.filter((target) => !supportsToolFreeMode(target.provider));
  if (ineligible.length > 0) {
    throw new Error(
      `Advisor requires a tool-free advisor provider; unsupported chain targets: ${ineligible.map((t) => t.provider).join(", ")} (currently supported: claude, agy, codex)`,
    );
  }
}
export function chainSupportsProfile(chain: AdvisorTarget[], profile: AdvisorExecutionProfile): boolean {
  try { assertChainSupportsProfile(chain, profile); return true; } catch { return false; }
}
