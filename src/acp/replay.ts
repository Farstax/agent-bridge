import type { SessionNotification } from "@agentclientprotocol/sdk";

export type AcpUpdateChannel = "replay" | "live";

export interface AcpObservedUpdate {
  readonly channel: AcpUpdateChannel;
  readonly notification: SessionNotification;
}

/**
 * Distinguishes ACP session-load history from live turn output so replayed
 * messages cannot be delivered as current Telegram/Discord answers.
 */
export class AcpReplayGate {
  private channel: AcpUpdateChannel = "live";

  beginLoad(): void {
    this.channel = "replay";
  }

  endLoad(): void {
    this.channel = "live";
  }

  beginResume(): void {
    this.channel = "live";
  }

  endResume(): void {
    this.channel = "live";
  }

  observe(notification: SessionNotification): AcpObservedUpdate {
    return { channel: this.channel, notification };
  }
}

export function liveDeliveryText(updates: readonly AcpObservedUpdate[]): string {
  let text = "";
  for (const update of updates) {
    if (update.channel !== "live") continue;
    const payload = update.notification.update;
    if (payload.sessionUpdate !== "agent_message_chunk") continue;
    if (payload.content.type === "text") text += payload.content.text;
  }
  return text;
}
