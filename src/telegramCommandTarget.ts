/**
 * PURPOSE: Resolve Telegram bot-qualified abort commands before neutral turn dispatch.
 * Keeps Telegram bot identity checks out of the surface-neutral BridgeEngine.
 * NEIGHBORS: src/index-interactive.ts, src/interactiveBot.ts
 */

import type { InteractiveTurnInput } from "./interactiveIngress.js";
import {
  dispatchUnifiedTelegramUpdate,
  type UnifiedTelegramUpdateEngine,
} from "./interactiveBot.js";
import type { TelegramUpdate } from "./types.js";

function targetQualifiedAbortUpdate(
  update: TelegramUpdate,
  botUsername?: string | null,
): TelegramUpdate | null {
  const message = update.message;
  const rawText = message?.text?.trim();
  if (!message || !rawText) return update;

  const match = /^\/(stop|cancel)@([a-z0-9_]+)$/i.exec(rawText);
  if (!match) return update;

  const currentBot = botUsername?.trim().toLowerCase();
  if (!currentBot || match[2].toLowerCase() !== currentBot) return null;

  return {
    ...update,
    message: {
      ...message,
      text: `/${match[1].toLowerCase()}`,
    },
  };
}

/**
 * Bot-qualified abort controls fail closed: only the current bot's command is
 * canonicalized; a command for another or unknown bot is swallowed.
 */
export async function dispatchTargetedTelegramUpdate(
  update: TelegramUpdate,
  chatKey: string,
  surfaceIdentity: string,
  engine: UnifiedTelegramUpdateEngine,
  dispatchMessage: (turn: InteractiveTurnInput) => Promise<void>,
  botUsername?: string | null,
): Promise<void> {
  const targetedUpdate = targetQualifiedAbortUpdate(update, botUsername);
  if (!targetedUpdate) return;
  await dispatchUnifiedTelegramUpdate(targetedUpdate, chatKey, surfaceIdentity, engine, dispatchMessage);
}
