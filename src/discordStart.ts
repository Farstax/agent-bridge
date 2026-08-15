import type { TelegramMessage, TelegramUpdate } from "./types.js";
import { parseStartPayload } from "./commands.js";

export type DiscordStartResolution =
  | { kind: "accepted"; update: TelegramUpdate }
  | { kind: "rejected"; reason: "invalid_payload" };

/**
 * Convert one explicit Discord /start interaction into the existing
 * Telegram-shaped engine boundary. The interaction id becomes both update and
 * message identity, so BridgeEngine's existing replay claim remains active.
 */
export function resolveDiscordStartInteraction(
  interaction: any,
  context: { chatId: number; userId: number; username?: string; chatType?: "private" | "supergroup" },
): DiscordStartResolution {
  if (interaction?.type !== 2 || interaction?.data?.name !== "start") {
    return { kind: "rejected", reason: "invalid_payload" };
  }
  const options = interaction?.data?.options;
  const payloadOptions = Array.isArray(options) ? options.filter((option: any) => option?.name === "payload") : [];
  if (payloadOptions.length > 1) return { kind: "rejected", reason: "invalid_payload" };
  const payloadOption = payloadOptions[0];
  const rawPayload = payloadOption?.value;
  const hasPayload = payloadOption !== undefined;
  const text = !hasPayload ? "/start" : typeof rawPayload === "string" ? `/start ${rawPayload}` : "";
  if (!text || (hasPayload && !parseStartPayload(text))) {
    return { kind: "rejected", reason: "invalid_payload" };
  }

  const interactionId = String(interaction?.id ?? "");
  if (!interactionId) return { kind: "rejected", reason: "invalid_payload" };
  let messageId: number;
  try {
    messageId = Number(BigInt(interactionId) % BigInt(Number.MAX_SAFE_INTEGER));
  } catch {
    return { kind: "rejected", reason: "invalid_payload" };
  }
  const message: TelegramMessage = {
    message_id: messageId,
    chat: { id: context.chatId, type: context.chatType ?? "private" },
    from: { id: context.userId, first_name: context.username ?? "User" },
    text,
  };
  return { kind: "accepted", update: { update_id: messageId, message } };
}
