from pathlib import Path

engine = Path("src/engine.ts")
text = engine.read_text()
import_anchor = 'import { buildEffortKeyboard, buildEffortText, effortSettingKey, resolveDefaultEffort, resolveEffort, isEffortLevel, type EffortLevel } from "./effort.js";\n'
import_line = 'import { resolveAcpTelegramConfigCallback } from "./acp/telegramConfigCallback.js";\n'
if import_line not in text:
    if import_anchor not in text:
        raise SystemExit("engine import anchor missing")
    text = text.replace(import_anchor, import_anchor + import_line, 1)

start_marker = "  async handleCallback(callbackQuery: TelegramCallbackQuery, providedChatKey?: string): Promise<void> {"
end_marker = "\n  async sendText("
start = text.index(start_marker)
end = text.index(end_marker, start)
replacement = r'''  async handleCallback(callbackQuery: TelegramCallbackQuery, providedChatKey?: string): Promise<void> {
    const fromId = callbackQuery?.from?.id;
    if (!this.opts.allowedUserIds.has(String(fromId))) return;
    if (!isAgentKind(this.kind) || !this.opts.fullConfig) return;

    const data = String(callbackQuery?.data || "");
    const acpSelection = resolveAcpTelegramConfigCallback(data);
    if (acpSelection) {
      if (acpSelection.providerId !== this.kind) return;
      const messageId = callbackQuery.message?.message_id;
      const chatId = callbackQuery.message?.chat?.id;
      const threadId = callbackQuery.message?.message_thread_id;
      if (!chatId || !messageId) return;
      if (!acpSelection.useProviderDefault && acpSelection.value === null) {
        await this.client.answerCallbackQuery({
          callback_query_id: callbackQuery.id,
          text: "That provider option is no longer available. Open the settings again.",
        });
        return;
      }

      if (acpSelection.category === "thought_level") {
        const next = acpSelection.useProviderDefault ? null : acpSelection.value!;
        this.db.setSetting(effortSettingKey(this.kind), next);
        const displayEffort = next ?? resolveDefaultEffort(this.kind);
        await this.client.answerCallbackQuery({ callback_query_id: callbackQuery.id });
        await this.client.editMessageText({
          chat_id: chatId,
          message_id: messageId,
          text: buildEffortText(this.kind, displayEffort, acpSelection.useProviderDefault),
          reply_markup: buildEffortKeyboard(this.kind, displayEffort, acpSelection.useProviderDefault),
        });
        await this.sendText(chatId, {
          text: `✓ Effort set to ${acpSelection.useProviderDefault ? "provider default" : next}`,
          message_thread_id: threadId,
        });
        return;
      }

      const next = acpSelection.useProviderDefault ? null : acpSelection.value!;
      this.db.setSetting(this.kind, next);
      await this.client.answerCallbackQuery({ callback_query_id: callbackQuery.id });
      await this.client.editMessageText({
        chat_id: chatId,
        message_id: messageId,
        text: buildModelsText(this.kind, { db: this.db, config: this.opts.fullConfig }),
        reply_markup: buildModelKeyboard(
          this.kind,
          this.opts.botConfig.modelPreference,
          next,
          acpSelection.useProviderDefault,
        ),
      });
      await this.sendText(chatId, {
        text: `✓ Model set to ${acpSelection.useProviderDefault ? "provider default" : next}`,
        message_thread_id: threadId,
      });
      return;
    }

    const [action, targetKind, ...rest] = data.split(":");
    if (action === "queue_mode") {
      const value = targetKind.trim();
      const chatId = callbackQuery.message?.chat?.id;
      const messageId = callbackQuery.message?.message_id;
      const chatType = callbackQuery.message?.chat?.type ?? "private";
      const threadId = callbackQuery.message?.message_thread_id;
      if (!chatId || !messageId || !["augment", "interrupt", "queue", "reset"].includes(value)) return;
      const chatKey = providedChatKey ?? topicChatKey(chatId, chatType, threadId);
      this.db.setSetting(busyMessageModeSettingKey(this.surfaceIdentity, chatKey), value === "reset" ? null : value);
      const effective = this._busyMessageMode(chatKey);
      await this.client.answerCallbackQuery({ callback_query_id: callbackQuery.id, text: `Busy-message mode: ${effective}` });
      await this.client.editMessageText({
        chat_id: chatId,
        message_id: messageId,
        text: `Busy-message mode: ${effective}. This applies to new messages while this lane is busy.`,
        reply_markup: buildBusyMessageModeKeyboard(effective),
      });
      await this.sendText(chatId, { text: `✓ Busy-message mode set to ${effective}`, message_thread_id: threadId });
      return;
    }
    if (!["model", "effort"].includes(action) || targetKind !== this.kind) return;

    const value = rest.join(":").trim();
    const messageId = callbackQuery.message?.message_id;
    const chatId = callbackQuery.message?.chat?.id;
    const threadId = callbackQuery.message?.message_thread_id;
    if (!chatId || !messageId) return;

    // ACP-backed providers accept only the bounded token callbacks above. Raw
    // legacy callbacks could contain invented or stale provider-owned values.
    if (this.kind === "codex" || this.kind === "claude") {
      await this.client.answerCallbackQuery({
        callback_query_id: callbackQuery.id,
        text: "This settings button has expired. Open the settings again.",
      });
      return;
    }

    if (action === "effort") {
      const next = value === "reset" ? resolveDefaultEffort(this.kind) : value;
      if (!isEffortLevel(next)) {
        await this.client.answerCallbackQuery({ callback_query_id: callbackQuery.id, text: "Unsupported effort" });
        return;
      }
      this.db.setSetting(effortSettingKey(this.kind), value === "reset" ? null : next);
      await this.client.answerCallbackQuery({ callback_query_id: callbackQuery.id });
      await this.client.editMessageText({
        chat_id: chatId,
        message_id: messageId,
        text: buildEffortText(this.kind, next),
        reply_markup: buildEffortKeyboard(this.kind, next),
      });
      await this.sendText(chatId, { text: `✓ Effort set to ${next}`, message_thread_id: threadId });
      return;
    }

    if (value === "reset") {
      this.db.setSetting(this.kind, null);
      if (this.kind === "antigravity") setAntigravityModel(null);
      await this.client.answerCallbackQuery({
        callback_query_id: callbackQuery.id,
        text: `${this.kind} reset to default`,
      });
      await this.client.editMessageText({
        chat_id: chatId,
        message_id: messageId,
        text: buildModelsText(this.kind, { db: this.db, config: this.opts.fullConfig }),
        reply_markup: buildModelKeyboard(this.kind, this.opts.botConfig.modelPreference, null),
      });
      return;
    }

    this.db.setSetting(this.kind, value);
    if (this.kind === "antigravity") setAntigravityModel(value);
    await this.client.answerCallbackQuery({ callback_query_id: callbackQuery.id });
    await this.client.editMessageText({
      chat_id: chatId,
      message_id: messageId,
      text: buildModelsText(this.kind, { db: this.db, config: this.opts.fullConfig }),
      reply_markup: buildModelKeyboard(this.kind, this.opts.botConfig.modelPreference, value),
    });
    await this.sendText(chatId, { text: `✓ Model set to ${value}`, message_thread_id: threadId });
  }
'''
text = text[:start] + replacement + text[end:]
engine.write_text(text)

opaque = Path("test/acpOpaqueEffort.test.ts")
opaque_text = opaque.read_text()
opaque_text = opaque_text.replace(
'''import {
  buildEffortKeyboard,
  buildEffortText,
  isEffortLevel,
  resolveDefaultEffort,
  resolveEffort,
} from "../src/effort.js";
''',
'''import {
  buildEffortKeyboard,
  buildEffortText,
  isEffortLevel,
  resolveDefaultEffort,
  resolveEffort,
} from "../src/effort.js";
import { buildAcpTelegramConfigCallbackData } from "../src/acp/telegramConfigCallback.js";
'''
)
opaque_text = opaque_text.replace(
'''    expect(isEffortLevel("default")).toBe(true);
    expect(isEffortLevel("adaptive")).toBe(true);

    const keyboard = buildEffortKeyboard("claude", "adaptive");
    expect(keyboard.inline_keyboard.flat()).toEqual(expect.arrayContaining([
      expect.objectContaining({ callback_data: "effort:claude:default" }),
      expect.objectContaining({ callback_data: "effort:claude:adaptive", text: "✓ Adaptive" }),
      expect.objectContaining({ callback_data: "effort:claude:reset" }),
    ]));
''',
'''    // ACP values stay provider-owned; the generic Bridge validator must not
    // accept them merely because another live ACP snapshot advertised them.
    expect(isEffortLevel("default")).toBe(false);
    expect(isEffortLevel("adaptive")).toBe(false);

    const keyboard = buildEffortKeyboard("claude", "adaptive");
    expect(keyboard.inline_keyboard.flat()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        callback_data: buildAcpTelegramConfigCallbackData("claude", "thought_level", "default"),
      }),
      expect.objectContaining({
        callback_data: buildAcpTelegramConfigCallbackData("claude", "thought_level", "adaptive"),
        text: "✓ Adaptive",
      }),
      expect.objectContaining({
        callback_data: buildAcpTelegramConfigCallbackData("claude", "thought_level", null),
      }),
    ]));
'''
)
opaque.write_text(opaque_text)

Path("test/acpTelegramConfigCallback.test.ts").write_text(r'''import { afterEach, describe, expect, it } from "vitest";
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
''')
