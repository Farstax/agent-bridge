import type { BridgeDb } from "./db.js";

export type BusyMessageMode = "augment" | "interrupt" | "queue";

export function busyMessageModeSettingKey(surface: string, chatKey: string): string {
  return `busy_message_mode:${surface}:${chatKey}`;
}

export function resolveLaneBusyMessageMode(
  db: BridgeDb,
  surface: string,
  chatKey: string,
  fallback: BusyMessageMode,
): BusyMessageMode {
  const override = db.getSetting(busyMessageModeSettingKey(surface, chatKey));
  return override === "augment" || override === "interrupt" || override === "queue" ? override : fallback;
}

export function buildBusyMessageModeKeyboard(active: BusyMessageMode): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
  const modes: BusyMessageMode[] = ["augment", "interrupt", "queue"];
  return {
    inline_keyboard: [
      modes.map((mode) => ({ text: mode === active ? `✓ ${mode}` : mode, callback_data: `queue_mode:${mode}` })),
      [{ text: "Use configured default", callback_data: "queue_mode:reset" }],
    ],
  };
}

export function isBusyMessageModeSelection(value: string): value is BusyMessageMode | "reset" {
  return value === "augment" || value === "interrupt" || value === "queue" || value === "reset";
}

/** Canonical busy-mode mutation shared by every adapter; "reset" restores the configured default. */
export function setLaneBusyMessageMode(
  db: BridgeDb,
  surface: string,
  chatKey: string,
  value: BusyMessageMode | "reset",
  fallback: BusyMessageMode,
): BusyMessageMode {
  db.setSetting(busyMessageModeSettingKey(surface, chatKey), value === "reset" ? null : value);
  return resolveLaneBusyMessageMode(db, surface, chatKey, fallback);
}
