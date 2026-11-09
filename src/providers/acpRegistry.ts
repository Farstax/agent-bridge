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
 * The immutable ACP distribution selection. Update only through isolated
 * provider qualification and the release lock.
 */
const RELEASE_LOCKED_ACP_REGISTRY_ENTRIES: Readonly<Partial<Record<ProviderId, AcpRegistryAgentEntry>>> = {
  codex: {
    id: "codex-acp",
    name: "Codex",
    version: "2.6.0",
    description: "ACP adapter for OpenAI's coding assistant",
    repository: "https://github.com/agentclientprotocol/codex-acp",
    authors: ["OpenAI", "JetBrains s.r.o", "Zed Industries"],
    license: "Apache-2.0",
    license_url: "https://github.com/agentclientprotocol/codex-acp/blob/main/LICENSE",
    distribution: {
      npx: {
        package: "@agentclientprotocol/codex-acp@2.6.0",
      },
    },
  },
  claude: {
    id: "claude-acp",
    name: "Claude Agent",
    version: "0.99.1",
    description: "ACP adapter for the Claude Agent SDK",
    repository: "https://github.com/agentclientprotocol/claude-agent-acp",
    license: "Apache-2.0",
    license_url: "https://github.com/agentclientprotocol/claude-agent-acp/blob/v0.99.1/LICENSE",
    distribution: {
      npx: {
        package: "@agentclientprotocol/claude-agent-acp@0.99.1",
      },
    },
  },
  grok: {
    id: "grok-build",
    name: "Grok Build",
    version: "1.0.70",
    description: "xAI's coding agent and CLI",
    website: "https://x.ai/cli",
    authors: ["xAI"],
    license: "proprietary",
    license_url: "https://x.ai/legal/terms-of-service",
    distribution: {
      npx: {
        package: "@xai-official/grok@1.0.70",
        args: ["agent", "stdio"],
      },
    },
  },
  agy: {
    id: "antigravity-acp",
    name: "Google Antigravity",
    version: "1.5.2",
    description: "Official Google Antigravity CLI ACP",
    website: "https://antigravity.google/docs/cli/acp",
    authors: ["Google LLC"],
    license: "proprietary",
    license_url: "https://antigravity.google/terms",
    distribution: {
      binary: {
        "linux-x86_64": {
          archive: "https://github.com/google-antigravity/antigravity-cli/releases/download/1.5.2/agy_cli_linux_x64.tar.gz",
          sha256: "da696a8dc6122a63d5ffbdd21b02c8a62d5361fba0ed7d3bc2d2619889e62711",
          cmd: "./agy",
          args: ["acp"],
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
          archive: "https://downloads.cursor.com/lab/2026.10.22-27dcf5f/linux/x64/agent-cli-package.tar.gz",
          sha256: "85296944e4600a83c4b764f578d1502bf9c416db200d33a593e8f3ecabfdc294",
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
