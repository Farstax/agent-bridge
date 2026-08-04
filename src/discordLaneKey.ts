/**
 * BridgeEngine receives Discord channel IDs through the numeric Telegram-shaped
 * adapter. Persist Discord lane-scoped state using this same stable alias.
 */
export function discordLaneKey(channelId: string): string {
  const snowflake = BigInt(channelId || "0");
  return String(Number(snowflake % BigInt(Number.MAX_SAFE_INTEGER)));
}
