import type { BridgeDb } from "./db.js";
import type { BotKind } from "./types.js";
import { getCliWorkingDir } from "./bridge.js";
import { hasAcpSessionConfigSnapshot } from "./acp/sessionConfig.js";
import { isAcpBackedBot } from "./providers/registry.js";
import { lookupProviderSession, persistProviderSession } from "./providers/sessionRuntime.js";
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

/**
 * Ensure ACP-backed settings commands have a live provider-owned catalogue.
 * This runs before the synchronous command renderer and never consumes a user turn.
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
  const result = await discover({
    bot: input.kind,
    cwd: getCliWorkingDir(input.kind),
    conversationId: input.chatKey,
    existingAcpSessionId,
    executionMode: input.executionMode,
  });
  persistProviderSession(input.db, input.chatKey, input.kind, result.sessionId);
  return true;
}

export function isAcpConfigControlCommand(commandText: string): boolean {
  return controlCategory(commandText) !== null;
}
