import { basename } from "node:path";
import { loadBotsConfig } from "../config.js";
import {
  type ProviderAdapter,
  type ProviderId,
  PROVIDER_IDS,
} from "./types.js";
import type { AcpProviderPolicy } from "./acpRuntime.js";
import { createPlannerStallWatch } from "./antigravityRuntime.js";
import { codexAcpPolicy } from "./codexAcpPolicy.js";

const ADAPTERS: Readonly<Record<ProviderId, ProviderAdapter>> = {
  codex: {
    id: "codex",
    displayName: "Codex",
    executable: "codex-acp",
    versionArgs: ["--version"],
    defaultArgs: [],
    capabilities: {
      interactive: true,
      fallbackTarget: true,
      toolFree: false,
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
  cursor: {
    id: "cursor",
    displayName: "Cursor",
    executable: "cursor-agent",
    versionArgs: ["--version"],
    defaultArgs: ["-p", "--output-format", "json"],
    capabilities: {
      interactive: true,
      fallbackTarget: true,
      toolFree: false,
    },
  },
};

/** ACP-backed providers opt into one generic runtime with only provider-owned differences here. */
const ACP_POLICIES: Readonly<Partial<Record<ProviderId, AcpProviderPolicy>>> = {
  codex: codexAcpPolicy,
};

/**
 * buildCliInvocation() uses CLI-kind vocabulary ("antigravity"), while the
 * provider registry uses "agy". Keep the vocabulary conversion in one place.
 */
const BOT_NAME_TO_PROVIDER_ID: Readonly<Record<string, ProviderId>> = {
  codex: "codex",
  claude: "claude",
  agy: "agy",
  antigravity: "agy",
  grok: "grok",
  cursor: "cursor",
};

export function providerIdForBotName(bot: string): ProviderId | null {
  return BOT_NAME_TO_PROVIDER_ID[bot] ?? null;
}

export function getAcpProviderPolicy(id: ProviderId): AcpProviderPolicy | null {
  return ACP_POLICIES[id] ?? null;
}

export function supportsToolFreeMode(bot: string): boolean {
  const id = providerIdForBotName(bot);
  if (!id) return false;
  return getAcpProviderPolicy(id)?.toolFree ?? ADAPTERS[id].capabilities.toolFree;
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
  if (!adapter) throw new Error(`Unknown provider id: ${id}`);
  return adapter;
}

export function getProviderAdapters(): readonly ProviderAdapter[] {
  return PROVIDER_IDS.map((id) => ADAPTERS[id]);
}

/** Resolve the command used by the live bridge runtime, including ACP policy overrides. */
export function resolveProviderExecutable(
  id: ProviderId,
  env: Record<string, string | undefined> = process.env,
): string {
  const acp = getAcpProviderPolicy(id);
  if (acp?.resolveExecutable) return acp.resolveExecutable(env);
  const bot = id === "agy" ? "antigravity" : id;
  return loadBotsConfig(env)[bot].command;
}

export function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}

export function assertProviderId(value: string): ProviderId {
  if (!isProviderId(value)) throw new Error(`Unknown provider id: ${value}`);
  return value;
}

export { PROVIDER_IDS } from "./types.js";
export type { ProviderAdapter, ProviderCapabilities, ProviderErrorClassification, ProviderId } from "./types.js";
