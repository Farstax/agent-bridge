import type { ProviderId } from "./types.js";
import { CURSOR_ACP_VERSION } from "./cursorAcpConfig.js";

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
  claude: {
    id: "claude-acp",
    name: "Claude Agent",
    version: "0.81.2",
    description: "ACP adapter for the Claude Agent SDK",
    repository: "https://github.com/agentclientprotocol/claude-agent-acp",
    license: "Apache-2.0",
    license_url: "https://github.com/agentclientprotocol/claude-agent-acp/blob/v0.81.2/LICENSE",
    distribution: {
      npx: {
        package: "@agentclientprotocol/claude-agent-acp@0.81.2",
      },
    },
  },
  grok: {
    id: "grok-build",
    name: "Grok Build",
    version: "1.0.41",
    description: "xAI's coding agent and CLI",
    website: "https://x.ai/cli",
    authors: ["xAI"],
    license: "proprietary",
    license_url: "https://x.ai/legal/terms-of-service",
    distribution: {
      npx: {
        package: "@xai-official/grok@1.0.41",
        args: ["agent", "stdio"],
      },
    },
  },
  agy: {
    id: "antigravity-acp",
    name: "Google Antigravity",
    version: "1.2.1",
    description: "Google’s AI coding agent",
    website: "https://antigravity.google/docs/ide/extensions",
    authors: ["Google LLC"],
    license: "proprietary",
    license_url: "https://antigravity.google/terms",
    distribution: {
      binary: {
        "linux-x86_64": {
          archive: "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.2.1-linux-x86_64.zip",
          sha256: "9fbf0bd584a26478161f637cabd75113f72541c842d148f578ef1a6a9edcb843",
          cmd: "./agy_acp_server.par",
          args: ["--uid="],
        },
      },
    },
  },
  cursor: {
    id: "cursor",
    name: "Cursor",
    version: CURSOR_ACP_VERSION,
    description: "Cursor's coding agent",
    website: "https://cursor.com/docs/cli/acp",
    authors: ["Cursor"],
    license: "proprietary",
    license_url: "https://cursor.com/terms-of-service",
    distribution: {
      binary: {
        "linux-x86_64": {
          archive: "https://downloads.cursor.com/lab/2026.09.23-86fc751/linux/x64/agent-cli-package.tar.gz",
          sha256: "740dd9d6eb5aec36ca90eaedf9fd5e2c489cd674d69b5147b3c2670f02d9776d",
          cmd: "./dist-package/cursor-agent",
          args: ["acp"],
        },
      },
    },
  },
};

export function getLockedAcpRegistryEntry(providerId: ProviderId): AcpRegistryAgentEntry | null {
  return RELEASE_LOCKED_ACP_REGISTRY_ENTRIES[providerId] ?? null;
}
