import type { SessionNotification } from "@agentclientprotocol/sdk";
import { reconstructLogicalMessages, renderLogicalMessages } from "./logicalMessages.js";

export type AcpUpdateChannel = "replay" | "live";

export interface AcpObservedUpdate {
  readonly channel: AcpUpdateChannel;
  readonly notification: SessionNotification;
}

/**
 * Distinguishes ACP session/load history from live turn output so replayed
 * messages cannot be delivered as current Telegram/Discord answers. ACP v1
 * only defines replay for session/load; session/resume explicitly resumes a
 * live connection without returning previous messages, so there is no
 * resume-replay phase to gate.
 */
export class AcpReplayGate {
  private channel: AcpUpdateChannel = "live";

  beginLoad(): void {
    this.channel = "replay";
  }

  endLoad(): void {
    this.channel = "live";
  }

  observe(notification: SessionNotification): AcpObservedUpdate {
    return { channel: this.channel, notification };
  }
}

/**
 * Select live agent text, optionally scoped to one ACP session. Callers that
 * own a parent/root turn must provide its session id so native child-session
 * output remains observable without becoming parent delivery text. Text is
 * reconstructed into logical messages so this and live preview share one
 * boundary contract.
 */
export function liveDeliveryText(
  updates: readonly AcpObservedUpdate[],
  sessionId?: string,
): string {
  const relevant = updates.filter((update) =>
    update.channel === "live" && (!sessionId || update.notification.sessionId === sessionId));
  return renderLogicalMessages(reconstructLogicalMessages(relevant.map((update) => update.notification.update)));
}
