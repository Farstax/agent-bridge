import { basename } from "node:path";
import { loadBotsConfig } from "../config.js";
import {
  type ProviderAdapter,
  type ProviderId,
  PROVIDER_IDS,
} from "./types.js";
import { createPlannerStallWatch } from "./antigravityRuntime.js";

const ADAPTERS: Readonly<Record<ProviderId, ProviderAdapter>> = {
  codex: {
    id: "codex",
    displayName: "Codex",
    executable: "codex",
    versionArgs: ["--version"],
    defaultArgs: ["--approval-mode", "full-auto"],
    capabilities: {
      interactive: true,
      fallbackTarget: true,
      toolFree: true,
    },
  },
  claude: {
    id: "claude",
    displayName: "Claude Code",
    executable: "claude",
    versionArgs: ["--version"],
    defaultArgs: ["--dangerously-skip-permissions"],
    capabilities: {
      interactive: true,
      fallbackTarget: true,
      toolFree: true,
    },
  },
  agy: {
    id: "agy",
    displayName: "Antigravity",
    executable: "agy",
    versionArgs: ["--version"],
    defaultArgs: ["--print"],
    capabilities: {
      interactive: true,
      fallbackTarget: true,
      toolFree: true,
    },
    processWatch: createPlannerStallWatch,
  },
  grok: {
    id: "grok",
    displayName: "Grok Build",
    executable: "grok",
    versionArgs: ["--version"],
    defaultArgs: ["-p", "--output-format", "streaming-json"],
    capabilities: {
      interactive: true,
      fallbackTarget: true,
      toolFree: false,
    },
  },
};

/**
 * buildCliInvocation()'s `bot` parameter uses CLI-kind vocabulary
 * ("antigravity"), not provider ids ("agy") — see ChainCliKind in types.ts.
 * Unrecognized bot names are treated as not supporting tool-free mode
 * rather than throwing, matching the original ALLOWED_TOOL_FREE_BOTS
 * Set-membership behaviour it replaces.
 */
const BOT_NAME_TO_PROVIDER_ID: Record<string, ProviderId> = {
  codex: "codex",
  claude: "claude",
  agy: "agy",
  antigravity: "agy",
  grok: "grok",
};

export function supportsToolFreeMode(bot: string): boolean {
  const id = BOT_NAME_TO_PROVIDER_ID[bot];
  return id ? ADAPTERS[id].capabilities.toolFree : false;
}

export function getProcessWatchForCommand(command: string): ProviderAdapter["processWatch"] {
  const executable = basename(command).toLowerCase();
  const commandText = command.toLowerCase();
  const adapter = getProviderAdapters().find((candidate) =>
    candidate.processWatch && (
      candidate.executable === executable
      || commandText.includes(candidate.executable)
      || (candidate.id === "agy" && commandText.includes("antigravity"))
    ),
  );
  return adapter?.processWatch;
}

export function getProviderAdapter(id: ProviderId): ProviderAdapter {
  const adapter = ADAPTERS[id];
  if (!adapter) {
    throw new Error(`Unknown provider id: ${id}`);
  }
  return adapter;
}

export function getProviderAdapters(): readonly ProviderAdapter[] {
  return PROVIDER_IDS.map((id) => ADAPTERS[id]);
}

/** Resolve the command used by the live bridge runtime, including command overrides. */
export function resolveProviderExecutable(id: ProviderId, env: Record<string, string | undefined> = process.env): string {
  const bot = id === "agy" ? "antigravity" : id;
  return loadBotsConfig(env)[bot].command;
}

export function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}

export function assertProviderId(value: string): ProviderId {
  if (!isProviderId(value)) {
    throw new Error(`Unknown provider id: ${value}`);
  }
  return value;
}

export { PROVIDER_IDS } from "./types.js";
export type { ProviderAdapter, ProviderCapabilities, ProviderErrorClassification, ProviderId } from "./types.js";
