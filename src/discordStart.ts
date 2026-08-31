import { parseStartPayload } from "./commands.js";
import type { InteractiveTurnInput } from "./interactiveIngress.js";

export type DiscordStartResolution = { kind: "accepted"; turn: InteractiveTurnInput } | { kind: "rejected"; reason: "invalid_payload" };
export function resolveDiscordStartInteraction(
  interaction: any,
  context: { surfaceIdentity: string; chatKey: string; userId: string; username?: string; chatType?: "private" | "supergroup" },
): DiscordStartResolution {
  if (interaction?.type !== 2 || interaction?.data?.name !== "start") return { kind: "rejected", reason: "invalid_payload" };
  const options = interaction?.data?.options;
  const payloadOptions = Array.isArray(options) ? options.filter((option: any) => option?.name === "payload") : [];
  if (payloadOptions.length > 1) return { kind: "rejected", reason: "invalid_payload" };
  const payloadOption = payloadOptions[0];
  const rawPayload = payloadOption?.value;
  const hasPayload = payloadOption !== undefined;
  const text = !hasPayload ? "/start" : typeof rawPayload === "string" ? `/start ${rawPayload}` : "";
  if (!text || (hasPayload && !parseStartPayload(text))) return { kind: "rejected", reason: "invalid_payload" };
  const messageId = String(interaction?.id ?? "");
  if (!messageId) return { kind: "rejected", reason: "invalid_payload" };
  return { kind: "accepted", turn: { surfaceIdentity: context.surfaceIdentity, chatKey: context.chatKey, actorId: context.userId, messageId, text, delivery: { chatId: context.chatKey, chatType: context.chatType ?? "private" }, attachments: [] } };
}
