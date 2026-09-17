import type { BridgeDb } from "./db.js";
import type { BotKind } from "./types.js";
import { getCliWorkingDir } from "./bridge.js";
import { clearAcpSessionConfigSnapshot, hasAcpSessionConfigSnapshot } from "./acp/sessionConfig.js";
import { isAcpBackedBot } from "./providers/registry.js";
import { lookupProviderSession } from "./providers/sessionRuntime.js";
import {
  discoverAcpProviderConfig,
  type AcpProviderConfigDiscoveryInput,
  type AcpProviderConfigDiscoveryResult,
} from "./providers/acpConfigDiscovery.js";

export type AcpConfigDiscover = (
  input: AcpProviderConfigDiscoveryInput,
) => Promise<AcpProviderConfigDiscoveryResult>;

function controlCategory(commandText: string): "model" | "thought_level" | null {
  const command = commandText.trim().toLowerCase().split(/\s+/, 1)[0]?.replace(/@\S+$/, "");
  if (command === "/models") return "model";
  if (command === "/effort") return "thought_level";
  return null;
}

function advertisesCategory(result: AcpProviderConfigDiscoveryResult, category: string): boolean {
  return result.configOptions.some((option) => option.type === "select" && option.category === category);
}

/**
 * Ensure ACP-backed settings commands have a live provider-owned catalogue.
 * Config-only sessions are transient: they must never become conversation sessions.
 */
export async function prepareInteractiveAcpConfigControl(input: {
  kind: BotKind;
  commandText: string;
  chatKey: string;
  db: BridgeDb;
  executionMode: "safe" | "trusted";
  discover?: AcpConfigDiscover;
}): Promise<boolean> {
  const category = controlCategory(input.commandText);
  if (!category || !isAcpBackedBot(input.kind)) return false;
  if (hasAcpSessionConfigSnapshot(input.kind)) return true;

  const discover = input.discover ?? discoverAcpProviderConfig;
  const existingAcpSessionId = lookupProviderSession(input.db, input.chatKey, input.kind);
  const discoveryInput = {
    bot: input.kind,
    cwd: getCliWorkingDir(input.kind),
    conversationId: input.chatKey,
    executionMode: input.executionMode,
  } as const;
  const first = await discover({
    ...discoveryInput,
    existingAcpSessionId,
  });

  if (existingAcpSessionId && !advertisesCategory(first, category)) {
    // ACP resume does not guarantee a catalogue replay after a Bridge restart.
    // Probe a fresh transient session for the provider-owned catalogue without
    // replacing the durable conversation session binding.
    clearAcpSessionConfigSnapshot(input.kind);
    try {
      await discover({
        ...discoveryInput,
        existingAcpSessionId: null,
      });
    } catch (error) {
      clearAcpSessionConfigSnapshot(input.kind);
      throw error;
    }
  }
  return true;
}

export function isAcpConfigControlCommand(commandText: string): boolean {
  return controlCategory(commandText) !== null;
}