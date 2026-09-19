import type { ProviderId } from "./types.js";

/**
 * Process-local routing evidence for a provider whose current credentials are
 * known unusable. This is deliberately ephemeral: credential ownership stays
 * with the provider and successful provider execution clears the degradation.
 */
const runtimeAuthDegradedProviders = new Set<ProviderId>();

export function markProviderRuntimeAuthDegraded(providerId: ProviderId): void {
  runtimeAuthDegradedProviders.add(providerId);
}

export function clearProviderRuntimeAuthDegraded(providerId: ProviderId): void {
  runtimeAuthDegradedProviders.delete(providerId);
}

export function isProviderRuntimeAuthDegraded(providerId: ProviderId): boolean {
  return runtimeAuthDegradedProviders.has(providerId);
}

export function getProviderRuntimeAuthDegradedProviders(): ReadonlySet<ProviderId> {
  return runtimeAuthDegradedProviders;
}
