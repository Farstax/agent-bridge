import { afterEach, describe, expect, it } from "vitest";
import {
  clearAcpSessionConfigSnapshot,
  replaceAcpSessionConfigSnapshot,
  setAcpProviderDefaultIntent,
} from "../src/acp/sessionConfig.js";
import {
  buildEffortKeyboard,
  buildEffortText,
  isEffortLevel,
  resolveEffort,
} from "../src/effort.js";

describe("ACP-native effort values", () => {
  afterEach(() => {
    clearAcpSessionConfigSnapshot("claude");
    clearAcpSessionConfigSnapshot("codex");
    setAcpProviderDefaultIntent("claude", "thought_level", false);
    setAcpProviderDefaultIntent("codex", "thought_level", false);
  });

  it("preserves every value advertised by the ACP thought-level selector", () => {
    replaceAcpSessionConfigSnapshot("claude", [{
      id: "effort",
      name: "Effort",
      category: "thought_level",
      type: "select",
      currentValue: "default",
      options: [
        { value: "default", name: "Default" },
        { value: "adaptive", name: "Adaptive" },
      ],
    }]);

    expect(isEffortLevel("default")).toBe(true);
    expect(isEffortLevel("adaptive")).toBe(true);

    const keyboard = buildEffortKeyboard("claude", "adaptive");
    expect(keyboard.inline_keyboard.flat()).toEqual(expect.arrayContaining([
      expect.objectContaining({ callback_data: "effort:claude:default" }),
      expect.objectContaining({ callback_data: "effort:claude:adaptive", text: "✓ Adaptive" }),
      expect.objectContaining({ callback_data: "effort:claude:reset" }),
    ]));

    expect(buildEffortText("claude", "adaptive")).toContain("Adaptive (adaptive)");
  });

  it("keeps persisted ACP effort values opaque so the live session can validate them", () => {
    const db = {
      getSetting(key: string) {
        if (key === "effort:claude") return "future-provider-value";
        return null;
      },
    };

    expect(resolveEffort("claude", db)).toBe("future-provider-value");
    expect(isEffortLevel("future-provider-value")).toBe(false);
  });

  it("does not broaden native Bridge effort normalization", () => {
    const db = {
      getSetting(key: string) {
        if (key === "effort:grok") return "future-provider-value";
        return null;
      },
    };

    expect(resolveEffort("grok", db)).toBe("medium");
  });
});
