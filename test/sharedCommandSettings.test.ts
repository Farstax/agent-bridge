import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { applyModelSelection } from "../src/bridge.js";
import { busyMessageModeSettingKey, isBusyMessageModeSelection, resolveLaneBusyMessageMode, setLaneBusyMessageMode } from "../src/busyMessageMode.js";
import { applyEffortSelection, effortSettingKey, resolveDefaultEffort, storeEffortPreference } from "../src/effort.js";
import { getUserCliPreference, switchManualCli } from "../src/interactiveBot.js";

// Issue #1130 slice 2: one canonical owner for each repeated command decision.
describe("shared command/settings mutations", () => {
  it("busy-mode: validates selections and resets to the surface default", () => {
    const db = openDb(":memory:");
    for (const value of ["augment", "interrupt", "queue", "reset"]) expect(isBusyMessageModeSelection(value)).toBe(true);
    for (const value of ["", "stop", "QUEUE", "queue_mode:queue"]) expect(isBusyMessageModeSelection(value)).toBe(false);
    expect(setLaneBusyMessageMode(db, "telegram:interactive", "c1", "interrupt", "augment")).toBe("interrupt");
    expect(db.getSetting(busyMessageModeSettingKey("telegram:interactive", "c1"))).toBe("interrupt");
    // Lanes and surfaces never share a mode.
    expect(resolveLaneBusyMessageMode(db, "telegram:interactive", "c2", "augment")).toBe("augment");
    expect(resolveLaneBusyMessageMode(db, "discord:interactive", "c1", "queue")).toBe("queue");
    expect(setLaneBusyMessageMode(db, "telegram:interactive", "c1", "reset", "augment")).toBe("augment");
    expect(db.getSetting(busyMessageModeSettingKey("telegram:interactive", "c1"))).toBeNull();
  });

  it("effort: rejects unsupported values without writing and resets to the provider default", () => {
    const db = openDb(":memory:");
    expect(applyEffortSelection(db, "codex", "turbo")).toBeNull();
    expect(db.getSetting(effortSettingKey("codex"))).toBeNull();
    expect(applyEffortSelection(db, "codex", "high")).toBe("high");
    expect(db.getSetting(effortSettingKey("codex"))).toBe("high");
    expect(applyEffortSelection(db, "codex", "reset")).toBe(resolveDefaultEffort("codex"));
    expect(db.getSetting(effortSettingKey("codex"))).toBeNull();
    // Provider-catalogue values (ACP) use the same single writer.
    storeEffortPreference(db, "claude", "xhigh-custom");
    expect(db.getSetting(effortSettingKey("claude"))).toBe("xhigh-custom");
    storeEffortPreference(db, "claude", null);
    expect(db.getSetting(effortSettingKey("claude"))).toBeNull();
  });

  it("model: stores under the provider key and resets on null or 'reset'", () => {
    const db = openDb(":memory:");
    applyModelSelection(db, "claude", "claude-opus-x");
    expect(db.getSetting("claude")).toBe("claude-opus-x");
    applyModelSelection(db, "claude", "reset");
    expect(db.getSetting("claude")).toBeNull();
    applyModelSelection(db, "claude", "m");
    applyModelSelection(db, "claude", null);
    expect(db.getSetting("claude")).toBeNull();
  });

  it("manual provider switch pairs the durable handoff with the in-memory chain and nothing else", () => {
    const db = openDb(":memory:");
    const identity = { surfaceIdentity: "discord:interactive", chatKey: "chan-1" };
    const active: Array<[string, string]> = [];
    switchManualCli(db, identity, "grok", { setActiveCli: (chatKey, cli) => { active.push([chatKey, cli]); } });
    expect(getUserCliPreference(db, identity)).toBe("grok");
    expect(active).toEqual([["chan-1", "grok"]]);
    // Another lane on the same surface keeps its own preference.
    expect(getUserCliPreference(db, { surfaceIdentity: "discord:interactive", chatKey: "chan-2" })).not.toBe("grok");
  });
});
