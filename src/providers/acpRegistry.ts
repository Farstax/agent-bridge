import type { ProviderId } from "./types.js";

/**
 * ACP Registry v1 entry shape used as the upstream distribution contract.
 * Keep these fields aligned with agentclientprotocol/registry/FORMAT.md rather
 * than inventing a Bridge-specific agent manifest.
 */
export interface AcpRegistryBinaryTarget {
  readonly archive: string;
  readonly sha256?: string;
  readonly cmd: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

export interface AcpRegistryAgentEntry {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly repository?: string;
  readonly website?: string;
  readonly authors?: readonly string[];
  readonly license?: string;
  readonly license_url?: string;
  readonly icon?: string;
  readonly distribution: {
    readonly binary?: Readonly<Record<string, AcpRegistryBinaryTarget>>;
    readonly npx?: {
      readonly package: string;
      readonly args?: readonly string[];
    };
    readonly uvx?: {
      readonly package: string;
      readonly args?: readonly string[];
    };
  };
}

export const ACP_REGISTRY_SCHEMA_VERSION = "1.0.0";

/**
 * Immutable release selection. The public ACP Registry is an update/discovery
 * source only; ordinary Runs never read it. A version change belongs in a
 * separately qualified Agent Bridge release.
 *
 * Codex deliberately remains on the already-qualified 1.10.0 adapter even
 * though the mutable upstream registry may advertise a newer release.
 */
const RELEASE_LOCKED_ACP_REGISTRY_ENTRIES: Readonly<Partial<Record<ProviderId, AcpRegistryAgentEntry>>> = {
  codex: {
    id: "codex-acp",
    name: "Codex",
    version: "1.10.0",
    description: "ACP adapter for OpenAI's coding assistant",
    repository: "https://github.com/agentclientprotocol/codex-acp",
    authors: ["OpenAI", "JetBrains s.r.o", "Zed Industries"],
    license: "Apache-2.0",
    license_url: "https://github.com/agentclientprotocol/codex-acp/blob/main/LICENSE",
    distribution: {
      npx: {
        package: "@agentclientprotocol/codex-acp@1.10.0",
      },
    },
  },
};

export function getLockedAcpRegistryEntry(providerId: ProviderId): AcpRegistryAgentEntry | null {
  return RELEASE_LOCKED_ACP_REGISTRY_ENTRIES[providerId] ?? null;
}
