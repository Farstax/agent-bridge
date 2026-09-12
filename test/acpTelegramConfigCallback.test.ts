import { afterEach, describe, expect, it } from "vitest";
import {
  clearAcpSessionConfigSnapshot,
  replaceAcpSessionConfigSnapshot,
} from "../src/acp/sessionConfig.js";
import { buildModelKeyboard } from "../src/bridge.js";
import { buildEffortKeyboard } from "../src/effort.js";
import {
  buildAcpTelegramConfigCallbackData,
  resolveAcpTelegramConfigCallback,
} from "../src/acp/telegramConfigCallback.js";

describe("ACP Telegram config callbacks", () => {
  afterEach(() => {
    clearAcpSessionConfigSnapshot("claude");
    clearAcpSessionConfigSnapshot("codex");
  });

  it("keeps opaque reset-like and long model values out of callback_data", () => {
    const longValue = `provider:${"x".repeat(200)}:reset`;
    replaceAcpSessionConfigSnapshot("claude", [{
      id: "model",
      category: "model",
      type: "select",
      currentValue: "reset",
      options: [
        { value: "reset", name: "Literal reset" },
        { value: longValue, name: "Long value" },
      ],
    }]);

    const keyboard = buildModelKeyboard("claude", [], "reset");
    const callbacks = keyboard.inline_keyboard.flat()
      .map((button: { callback_data: string }) => button.callback_data);

    expect(callbacks.every((value: string) => Buffer.byteLength(value, "utf8") <= 64)).toBe(true);
    expect(callbacks.every((value: string) => !value.includes(longValue))).toBe(true);

    const literalReset = buildAcpTelegramConfigCallbackData("claude", "model", "reset");
    const providerDefault = buildAcpTelegramConfigCallbackData("claude", "model", null);
    expect(literalReset).not.toBe(providerDefault);
    expect(resolveAcpTelegramConfigCallback(literalReset)).toMatchObject({
      providerId: "claude",
      category: "model",
      useProviderDefault: false,
      value: "reset",
    });
    expect(resolveAcpTelegramConfigCallback(
      buildAcpTelegramConfigCallbackData("claude", "model", longValue),
    )?.value).toBe(longValue);
  });

  it("resolves effort values only from the encoded provider live catalogue", () => {
    replaceAcpSessionConfigSnapshot("claude", [{
      id: "effort",
      category: "thought_level",
      type: "select",
      currentValue: "adaptive",
      options: [{ value: "adaptive", name: "Adaptive" }],
    }]);
    replaceAcpSessionConfigSnapshot("codex", [{
      id: "effort",
      category: "thought_level",
      type: "select",
      currentValue: "high",
      options: [{ value: "high", name: "High" }],
    }]);

    const claudeCallback = buildAcpTelegramConfigCallbackData("claude", "thought_level", "adaptive");
    expect(resolveAcpTelegramConfigCallback(claudeCallback)).toMatchObject({
      providerId: "claude",
      category: "thought_level",
      useProviderDefault: false,
      value: "adaptive",
    });

    const token = claudeCallback.split(":").at(-1);
    expect(resolveAcpTelegramConfigCallback(`acpe:codex:${token}`)).toMatchObject({
      providerId: "codex",
      category: "thought_level",
      useProviderDefault: false,
      value: null,
    });

    const keyboard = buildEffortKeyboard("claude", "adaptive");
    for (const button of keyboard.inline_keyboard.flat()) {
      expect(Buffer.byteLength(button.callback_data, "utf8")).toBeLessThanOrEqual(64);
    }
  });

  it("fails stale value callbacks closed while provider-default remains available", () => {
    replaceAcpSessionConfigSnapshot("claude", [{
      id: "model",
      category: "model",
      type: "select",
      currentValue: "sonnet",
      options: [{ value: "sonnet", name: "Sonnet" }],
    }]);
    const staleCallback = buildAcpTelegramConfigCallbackData("claude", "model", "sonnet");

    replaceAcpSessionConfigSnapshot("claude", [{
      id: "model",
      category: "model",
      type: "select",
      currentValue: "opus",
      options: [{ value: "opus", name: "Opus" }],
    }]);

    expect(resolveAcpTelegramConfigCallback(staleCallback)).toMatchObject({
      providerId: "claude",
      category: "model",
      useProviderDefault: false,
      value: null,
    });
    expect(resolveAcpTelegramConfigCallback(
      buildAcpTelegramConfigCallbackData("claude", "model", null),
    )).toEqual({
      providerId: "claude",
      category: "model",
      useProviderDefault: true,
      value: null,
    });
  });
});
