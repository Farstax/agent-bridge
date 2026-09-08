import { describe, expect, it } from "vitest";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import {
  AcpReplayGate,
  liveDeliveryText,
  type AcpObservedUpdate,
} from "../src/acp/replay.js";

function notification(text: string, sessionUpdate: "agent_message_chunk" | "user_message_chunk" = "agent_message_chunk"): SessionNotification {
  return {
    sessionId: "acp-sess-1",
    update: {
      sessionUpdate,
      content: { type: "text", text },
    },
  };
}

describe("ACP session-load replay suppression", () => {
  it("marks session/load updates as replay until load completes", () => {
    const gate = new AcpReplayGate();
    gate.beginLoad();
    const replayed = gate.observe(notification("old answer"));
    expect(replayed.channel).toBe("replay");
    gate.endLoad();
    const live = gate.observe(notification("new answer"));
    expect(live.channel).toBe("live");
  });

  it("marks session/resume updates as replay until resume completes", () => {
    const gate = new AcpReplayGate();
    gate.beginResume();
    const replayed = gate.observe(notification("old resume history"));
    expect(replayed.channel).toBe("replay");
    gate.endResume();
    const live = gate.observe(notification("only this turn"));
    expect(live.channel).toBe("live");
  });

  it("never selects replayed agent text for Telegram/Discord delivery", () => {
    const updates: AcpObservedUpdate[] = [
      { channel: "replay", notification: notification("yesterday's answer") },
      { channel: "replay", notification: notification("What is 2+2?", "user_message_chunk") },
      { channel: "live", notification: notification("today's answer") },
      { channel: "live", notification: notification(" thought", "user_message_chunk") },
    ];
    expect(liveDeliveryText(updates)).toBe("today's answer");
    expect(liveDeliveryText(updates)).not.toContain("yesterday");
  });
});
