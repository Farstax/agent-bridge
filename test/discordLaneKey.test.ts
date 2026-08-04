import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { busyMessageModeSettingKey, resolveLaneBusyMessageMode } from "../src/busyMessageMode.js";
import { discordLaneKey } from "../src/discordLaneKey.js";

describe("Discord queue-mode lane keys", () => {
  it("uses the same canonical key for interaction settings and Engine admission", () => {
    const db = openDb(":memory:");
    const channelId = "1234567890123456789";
    const laneKey = discordLaneKey(channelId);
    db.setSetting(busyMessageModeSettingKey("discord:interactive", laneKey), "interrupt");
    expect(resolveLaneBusyMessageMode(db, "discord:interactive", laneKey, "augment")).toBe("interrupt");
    expect(resolveLaneBusyMessageMode(db, "discord:interactive", channelId, "augment")).toBe("augment");
    db.close();
  });

  it("preserves lane isolation and survives reopening the database", () => {
    const path = `/tmp/discord-lane-key-${Date.now()}.sqlite`;
    const a = discordLaneKey("1234567890123456789");
    const b = discordLaneKey("9876543210987654321");
    const first = openDb(path);
    first.setSetting(busyMessageModeSettingKey("discord:interactive", a), "queue");
    first.close();
    const reopened = openDb(path);
    expect(resolveLaneBusyMessageMode(reopened, "discord:interactive", a, "augment")).toBe("queue");
    expect(resolveLaneBusyMessageMode(reopened, "discord:interactive", b, "augment")).toBe("augment");
    reopened.close();
  });
});
