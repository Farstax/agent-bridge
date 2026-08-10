import { execFileSync } from "node:child_process";
import { getProviderAdapters } from "./registry.js";
import {
  PROVIDER_CONTRACT_VERSION,
  qualificationHealthCheck,
  qualificationEvidencePath,
  readQualificationEvidence,
  normalizeProviderVersion,
  type QualificationHealthResult,
} from "./qualification.js";
import type { ProviderId } from "./types.js";

export interface InstalledProviderQualificationStatus extends QualificationHealthResult {
  provider: ProviderId;
  version: string;
}

export function readInstalledProviderVersions(): Partial<Record<ProviderId, string>> {
  const versions: Partial<Record<ProviderId, string>> = {};
  for (const adapter of getProviderAdapters()) {
    try {
      const raw = execFileSync(adapter.executable, ["--version"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5_000,
      }).trim();
      if (raw) versions[adapter.id] = normalizeProviderVersion(raw);
    } catch {
      // Missing/unavailable providers are already covered by ordinary doctor/health checks.
    }
  }
  return versions;
}

export function getQualificationFailedProviders(
  evidencePath: string = qualificationEvidencePath(),
): Set<ProviderId> {
  try {
    const evidence = readQualificationEvidence(evidencePath);
    const failed = new Set<ProviderId>();
    for (const [provider, record] of Object.entries(evidence.providers)) {
      if (record?.overall === "fail") failed.add(provider as ProviderId);
    }
    return failed;
  } catch {
    // Health/doctor surface unreadable evidence explicitly. Routing must not
    // infer that every provider is bad merely because its evidence file broke.
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
