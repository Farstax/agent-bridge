import { CliTimeoutError, ProviderStallError } from "../cliSupervisor.js";
import {
  classifyAnyProviderError,
  classifyProviderError,
  isClaudeOAuthRefreshContention,
  isFallbackEligibleProviderError,
} from "./errorClassification.js";
import {
  mergeProviderFailureEvidence,
  readProviderFailureEvidence,
  type ProviderFailureEvidence,
} from "./failureEvidence.js";
import type { ProviderErrorClassification, ProviderId } from "./types.js";

export type ProviderFallbackReason =
  | "capacity"
  | "auth_required"
  | "provider_stall"
  | "provider_unavailable"
  | "provider_transport_failure";

export interface ProviderRecoveryDecision {
  readonly classification: ProviderErrorClassification;
  /** Capacity or model unavailability, possibly recognised through another provider's wording. */
  readonly capacityExhausted: boolean;
  /** Why another provider may take over, or null when no provider switch is permitted. */
  readonly reason: ProviderFallbackReason | null;
  readonly authRequired: boolean;
  /** The reason when it is a provider transport/availability failure rather than an auth/capacity category. */
  readonly transportReason: Exclude<ProviderFallbackReason, "capacity" | "auth_required"> | null;
  /** One silent same-provider fresh-session retry (tier 2) is permitted. */
  readonly freshSessionRetry: boolean;
}

/**
 * The single authoritative provider-failure recovery decision. Route owners
 * (BridgeEngine/interactive dispatch and the surface-neutral router) consume
 * this instead of keeping their own eligibility checks.
 *
 * A broad `unknown` error is eligible only when the ACP runtime proved that no
 * `session/prompt` was ever submitted for this admitted action; classification
 * alone is never a side-effect safety proof (#575, #923).
 */
export function decideProviderRecovery(
  provider: ProviderId | null,
  error: Error,
  priorEvidence?: ProviderFailureEvidence | null,
): ProviderRecoveryDecision {
  const classification = provider ? classifyProviderError(provider, error) : classifyAnyProviderError(error);
  const claudeContention = provider === "claude" && isClaudeOAuthRefreshContention(error);
  const authRequired = classification.kind === "auth_required" || claudeContention;
  // Capacity wording is shared across provider CLIs (e.g. "session limit"), so
  // the category check stays provider-agnostic as it was at every old call site.
  const capacityExhausted = isFallbackEligibleProviderError(classification)
    || isFallbackEligibleProviderError(classifyAnyProviderError(error));
  const evidence = mergeProviderFailureEvidence(readProviderFailureEvidence(error), priorEvidence);

  // Transport/availability reasons are evaluated independently of the auth and
  // capacity categories (a stalled provider still abandons its session even if
  // its text also looks like capacity wording).
  let transportReason: ProviderRecoveryDecision["transportReason"] = null;
  if (error instanceof ProviderStallError) transportReason = "provider_stall";
  else if (error instanceof CliTimeoutError) transportReason = null;
  else if (classification.kind === "transient") {
    transportReason = claudeContention ? null : "provider_transport_failure";
  } else if (classification.kind === "fatal" && !/not a git repository/i.test(classification.reason)) {
    transportReason = "provider_unavailable";
  } else if (classification.kind === "unknown" && evidence?.promptSubmitted === false) {
    transportReason = "provider_transport_failure";
  }
  const reason: ProviderFallbackReason | null = authRequired
    ? "auth_required"
    : capacityExhausted ? "capacity" : transportReason;

  return {
    classification,
    reason,
    capacityExhausted,
    authRequired,
    transportReason,
    freshSessionRetry: classification.kind === "transient",
  };
}
