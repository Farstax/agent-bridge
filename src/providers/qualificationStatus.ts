import { getProviderAdapters, resolveProviderExecutable } from "./registry.js";
import {
  PROVIDER_CONTRACT_VERSION,
  qualificationHealthCheck,
  qualificationEvidencePath,
  readProviderVersion,
  readQualificationEvidence,
  isQualificationCurrent,
  type QualificationHealthResult,
} from "./qualification.js";
import type { ProviderId } from "./types.js";

export interface InstalledProviderQualificationStatus extends QualificationHealthResult {
  provider: ProviderId;
  version: string;
}

function readInstalledProviderVersion(providerId: ProviderId): string | undefined {
  try {
    return readProviderVersion(providerId, resolveProviderExecutable(providerId));
  } catch {
    return undefined;
  }
}

export function readInstalledProviderVersions(): Partial<Record<ProviderId, string>> {
  const versions: Partial<Record<ProviderId, string>> = {};
  for (const adapter of getProviderAdapters()) {
    const version = readInstalledProviderVersion(adapter.id);
    if (version) versions[adapter.id] = version;
  }
  return versions;
}

export function getQualificationFailedProviders(
  evidencePath: string = qualificationEvidencePath(),
  installedVersions?: Partial<Record<ProviderId, string>>,
): Set<ProviderId> {
  try {
    const evidence = readQualificationEvidence(evidencePath);
    const failed = new Set<ProviderId>();
    for (const [provider, record] of Object.entries(evidence.providers)) {
      if (record?.overall !== "fail") continue;
      const providerId = provider as ProviderId;
      const installedVersion = installedVersions
        ? installedVersions[providerId]
        : readInstalledProviderVersion(providerId);
      if (installedVersion && isQualificationCurrent(record, providerId, installedVersion)) {
        failed.add(providerId);
      }
    }
    return failed;
  } catch {
    // Health/doctor surface unreadable evidence explicitly. Routing must not
    // infer that every provider is bad merely because its evidence file broke.
    return new Set<ProviderId>();
  }
}

/** Whether one exact installed provider binary has a current explicit pass. */
export function isProviderQualificationPassed(
  providerId: ProviderId,
  evidencePath: string = qualificationEvidencePath(),
  installedVersion?: string,
): boolean {
  try {
    const evidence = readQualificationEvidence(evidencePath);
    const record = evidence.providers[providerId];
    if (record?.overall !== "pass") return false;
    const version = installedVersion ?? readInstalledProviderVersion(providerId);
    return Boolean(version && isQualificationCurrent(record, providerId, version));
  } catch {
    // Positive gating must fail closed when evidence is unreadable.
    return false;
  }
}

/** Providers with current, explicit passing evidence for supplied/installed binaries. */
export function getQualificationPassedProviders(
  evidencePath: string = qualificationEvidencePath(),
  installedVersions?: Partial<Record<ProviderId, string>>,
): Set<ProviderId> {
  try {
    const evidence = readQualificationEvidence(evidencePath);
    const passed = new Set<ProviderId>();
    for (const [provider, record] of Object.entries(evidence.providers)) {
      if (record?.overall !== "pass") continue;
      const providerId = provider as ProviderId;
      const installedVersion = installedVersions
        ? installedVersions[providerId]
        : readInstalledProviderVersion(providerId);
      if (installedVersion && isQualificationCurrent(record, providerId, installedVersion)) {
        passed.add(providerId);
      }
    }
    return passed;
  } catch {
    return new Set<ProviderId>();
  }
}

export function getInstalledQualificationStatus(
  evidencePath: string = qualificationEvidencePath(),
  installedVersions: Partial<Record<ProviderId, string>> = readInstalledProviderVersions(),
): InstalledProviderQualificationStatus[] {
  return Object.entries(installedVersions).flatMap(([provider, version]) => {
    if (!version) return [];
    const providerId = provider as ProviderId;
    return [{ provider: providerId, version, ...qualificationHealthCheck(providerId, version, evidencePath) }];
  });
}

export function formatQualificationSummary(
  evidencePath: string = qualificationEvidencePath(),
  installedVersions: Partial<Record<ProviderId, string>> = readInstalledProviderVersions(),
): string {
  let evidenceExists = false;
  try {
    evidenceExists = Object.keys(readQualificationEvidence(evidencePath).providers).length > 0;
  } catch (error) {
    return `provider qualification: evidence unreadable (${(error as Error).message})`;
  }
  if (!evidenceExists) {
    return `provider qualification: no evidence yet (contract v${PROVIDER_CONTRACT_VERSION})`;
  }
  const statuses = getInstalledQualificationStatus(evidencePath, installedVersions);
  if (statuses.length === 0) return "provider qualification: no installed providers detected";
  return statuses
    .map((status) => `provider qualification ${status.provider}: ${status.message}`)
    .join("\n");
}
