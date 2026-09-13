import { basename } from "node:path";
import { loadBotsConfig } from "../config.js";
import {
  type ProviderAdapter,
  type ProviderId,
  PROVIDER_IDS,
} from "./types.js";
import type { AcpProviderPolicy } from "./acpRuntime.js";
import { createPlannerStallWatch } from "./antigravityRuntime.js";
import { claudeAcpPolicy } from "./claudeAcpPolicy.js";
import { codexAcpPolicy } from "./codexAcpPolicy.js";
import { grokAcpPolicy } from "./grokAcpPolicy.js";

const ADAPTERS: Readonly<Record<ProviderId, ProviderAdapter>> = {
  codex: {
    id: "codex",
    displayName: "Codex",
    capabilities: {
      interactive: true,
      fallbackTarget: true,
    },
  },
  claude: {
    id: "claude",
    displayName: "Claude Code",
    capabilities: {
      interactive: true,
      fallbackTarget: true,
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
    capabilities: {
      interactive: true,
      fallbackTarget: true,
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
  claude: claudeAcpPolicy,
  grok: grokAcpPolicy,
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

/** Apply provider-owned exclusive environment metadata without shared provider-name branches. */
export function applyProviderChildEnvPolicy(
  id: ProviderId | null,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const policy of Object.values(ACP_POLICIES)) {
    for (const key of policy?.childEnv?.exclusiveKeys ?? []) delete out[key];
  }
  Object.assign(out, id ? ACP_POLICIES[id]?.childEnv?.overrides : undefined);
  return out;
}

export function supportsToolFreeMode(bot: string): boolean {
  const id = providerIdForBotName(bot);
  if (!id) return false;
  return getAcpProviderPolicy(id)?.toolFree ?? ADAPTERS[id].capabilities.toolFree ?? false;
}

export function getProcessWatchForCommand(command: string): ProviderAdapter["processWatch"] {
  const executable = basename(command).toLowerCase();
  const commandText = command.toLowerCase();
  const adapter = getProviderAdapters().find((candidate) =>
    candidate.processWatch && candidate.executable && (
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

/** Resolve a native provider command or an ACP policy's explicit installed-command override. */
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
