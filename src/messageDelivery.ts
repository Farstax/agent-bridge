import { splitTelegramText, toTelegramEntitiesText } from "./render.js";
import { toUserMessage, isCapacityExhaustedError } from "./cli.js";
import type { MessagingPlatform } from "./platform.js";
import type { CliResult } from "./types.js";
import { type as eventType } from "./events/types.js";
import type { BridgeEvent } from "./events/types.js";
import { reduce as reduceEvents } from "./events/reducer.js";
import { runViewToTelegramText } from "./events/telegramAdapter.js";
import {
  documentFallbackEnabled,
  routeNativeLayout,
} from "./nativeLayout.js";
import { parseMarkdownToIR, renderMarkerString, TELEGRAM_HTML_MARKERS, markdownTableToRichHtml } from "./markdownIR.js";

const MAX_TELEGRAM_TEXT = 4096;
const ANSWER_PREVIEW_EDIT_INTERVAL_MS = 700;

function truncate(text: string): string {
  return text.length > MAX_TELEGRAM_TEXT ? text.slice(-MAX_TELEGRAM_TEXT) : text;
}

function renderTelegramHtml(text: string): string {
  return renderMarkerString(parseMarkdownToIR(text), TELEGRAM_HTML_MARKERS, "\n\n");
}

function extractStatusProgress(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^STATUS:\s+\S/i.test(line))
    .map((line) => line.replace(/^STATUS:\s*/i, ""))
    .join("\n")
    .trim();
}

export async function sendTelegramMessage({
  client,
  kind,
  chatId,
  body,
}: {
  client: MessagingPlatform;
  kind: string;
  chatId: number;
  body: any;
}): Promise<number | null> {
  const text = String(body.text || "");
  const { text: _ignored, ...rest } = body;
  const route = routeNativeLayout(text, {
    documentEnabled: documentFallbackEnabled(),
  });

  if (route.kind === "document" && typeof client.sendDocumentBuffer === "function") {
    await client.sendDocumentBuffer({
      chat_id: chatId,
      ...rest,
      bytes: Buffer.from(text, "utf8"),
      filename: "response.md",
      mime_type: "text/markdown",
      caption: `Full response attached as response.md (${route.reason})`,
    });
    return null;
  }

  // Tables route through sendRichMessage (Telegram Bot API 10.1+) which accepts <table> HTML.
  // Falls back to card-style entity messages when sendRichMessage isn't available.
  if (route.kind === "html" && typeof client.sendRichMessage === "function") {
    const richHtml = markdownTableToRichHtml(text);
    try {
      await client.sendRichMessage({ chat_id: chatId, ...rest, rich_message: { html: richHtml } });
      return null;
    } catch {
      // sendRichMessage unsupported or rejected — fall through to card-style delivery
    }
  }

  return sendEntityMessages({ client, chatId, body: { ...rest, text } });
}

async function sendEntityMessages({
  client,
  chatId,
  body,
}: {
  client: MessagingPlatform;
  chatId: number;
  body: any;
}): Promise<number | null> {
  const chunks = splitTelegramText(String(body.text || ""));
  const { text: _ignored, ...rest } = body;
  let firstMessageId: number | null = null;

  for (let i = 0; i < chunks.length; i += 1) {
    const chunkText = chunks[i];
    const chunkBody: any = {
      chat_id: chatId,
      ...rest,
      text: chunkText,
    };

    if (i > 0) delete chunkBody.reply_markup;
    chunkBody.text = renderTelegramHtml(chunkText);
    chunkBody.parse_mode = "HTML";
    const response = await client.sendMessage(chunkBody);
    if (i === 0 && typeof response?.result?.message_id === "number") firstMessageId = response.result.message_id;
  }
  return firstMessageId;
}

function validateParity({
  kind,
  chatId,
  runId,
  finalText,
  errorText,
  sessionId,
}: {
  kind: string;
  chatId: number;
  runId?: string;
  finalText?: string;
  errorText?: string;
  sessionId?: string | null;
}) {
  try {
    const valRunId = runId || `val-${Math.random().toString(36).substring(2)}`;
    const events: BridgeEvent[] = [
      eventType.runStarted({
        runId: valRunId,
        bot: kind as any,
        chatId: String(chatId),
        command: "validation",
        cwd: process.cwd(),
        model: null,
      }),
    ];

    let expectedText = "";
    if (errorText) {
      expectedText = errorText;
      events.push(
        eventType.runFailed({
          runId: valRunId,
          bot: kind as any,
          chatId: String(chatId),
          error: errorText.startsWith("❌ ") ? errorText.slice(2) : errorText,
          category: "cli",
        })
      );
    } else {
      expectedText = finalText || "";
      events.push(
        eventType.runCompleted({
          runId: valRunId,
          bot: kind as any,
          chatId: String(chatId),
          text: expectedText,
          sessionId: sessionId || null,
        })
      );
    }

    const view = reduceEvents(events);
    const eventText = runViewToTelegramText(view);

    const cleanExpected = toTelegramEntitiesText(expectedText).text;
    const cleanEvent = eventText;

    if (cleanEvent !== cleanExpected) {
      console.warn(
        `[validation] Output mismatch for run ${valRunId}: legacy="${cleanExpected}" vs event="${cleanEvent}"`
      );
    }
  } catch (valErr) {
    console.warn(`[validation] Parity check failed to execute`, valErr);
  }
}

export async function sendMessageWithProgress({
  client,
  kind,
  chatId,
  execution,
  onProgress = () => {},
  body = {},
  showProgressNarration = false,
  isAborted,
  beforeFinalDelivery,
  afterFinalDelivery,
  propagateExecutionErrors = false,
  runId,
  onEvent,
}: {
  client: MessagingPlatform;
  kind: string;
  chatId: number;
  execution: ((onProgress: (text: string) => void, onAnswerDelta: (text: string) => void) => Promise<CliResult>) | Promise<CliResult>;
  onProgress?: (text: string) => void;
  body?: any;
  showProgressNarration?: boolean;
  isAborted?: () => boolean;
  beforeFinalDelivery?: () => boolean;
  afterFinalDelivery?: () => void | Promise<void>;
  propagateExecutionErrors?: boolean;
  runId?: string;
  onEvent?: (event: BridgeEvent) => void;
}): Promise<CliResult | null> {
  const { text: _ignored, ...rest } = body;

  const sendTyping = async () => {
    if (isAborted?.()) return;
    try {
      await client.sendChatAction({ chat_id: chatId, ...rest, action: "typing" });
    } catch {
      /* ignore */
    }
  };

  await sendTyping();
  const typingInterval = setInterval(sendTyping, 4500);

  // For antigravity: raw reasoning/progress should keep Telegram's typing
  // indicator alive. Visible narration is opt-in and only shows sanitized
  // STATUS lines, never generic thinking notes or raw pre-final narration.
  const streamingEnabled = kind === "antigravity";
  // Abandoned previews must be removable before fallback can publish the
  // authoritative answer. Clients without deletion support stay final-only.
  let answerPreviewEnabled = kind === "claude" && typeof client.deleteMessage === "function";
  let answerPreviewMessageId: number | null = null;
  let answerPreviewText = "";
  let answerPreviewDirty = false;
  let answerPreviewPending = false;
  let answerPreviewTimer: NodeJS.Timeout | null = null;
  let answerPreviewChain = Promise.resolve();
  let lastAnswerPreviewEditMs = 0;
  const answerPreviewUpdates: Promise<unknown>[] = [];
  let progressMsgId: number | null = null;
  let progressMsgPending = false;
  const progressUpdates: Promise<unknown>[] = [];

  let currentText = "";
  let lastProgressEditMs = 0;
  let lastSentPreviewText = "";
  let lastTypingSentMs = Date.now();
  const PROGRESS_EDIT_INTERVAL_MS = 5_000;
  const TYPING_REFRESH_INTERVAL_MS = 4_000;
  const originalOnProgress = onProgress;

  const renderAnswerPreview = (text: string): any => {
    const bounded = text.length > MAX_TELEGRAM_TEXT
      ? `${text.slice(0, MAX_TELEGRAM_TEXT - 1)}…`
      : text;
    try {
      return { text: renderTelegramHtml(bounded), parse_mode: "HTML" };
    } catch {
      return { text: bounded };
    }
  };

  const publishAnswerPreview = async (): Promise<void> => {
    if (!answerPreviewEnabled || !answerPreviewDirty || !answerPreviewText.trim() || isAborted?.()) return;
    answerPreviewDirty = false;
    const previewBody = { chat_id: chatId, ...body, ...renderAnswerPreview(answerPreviewText) };
    try {
      if (answerPreviewMessageId == null) {
        const sent = await client.sendMessage(previewBody);
        const messageId = sent?.result?.message_id;
        if (typeof messageId !== "number") throw new Error("Telegram preview message ID missing");
        answerPreviewMessageId = messageId;
      } else {
        await client.editMessageText({
          ...previewBody,
          message_id: answerPreviewMessageId,
        });
      }
      lastAnswerPreviewEditMs = Date.now();
    } catch {
      answerPreviewEnabled = false;
      answerPreviewDirty = false;
    }
  };

  const queueAnswerPreview = (immediate = false): void => {
    if (!answerPreviewEnabled || !answerPreviewText.trim() || isAborted?.()) return;
    answerPreviewDirty = true;
    const elapsed = Date.now() - lastAnswerPreviewEditMs;
    if (!immediate && answerPreviewMessageId != null && elapsed < ANSWER_PREVIEW_EDIT_INTERVAL_MS) {
      if (!answerPreviewTimer) {
        answerPreviewTimer = setTimeout(() => {
          answerPreviewTimer = null;
          queueAnswerPreview(true);
        }, ANSWER_PREVIEW_EDIT_INTERVAL_MS - elapsed);
      }
      return;
    }
    if (answerPreviewPending) return;
    answerPreviewPending = true;
    answerPreviewChain = answerPreviewChain
      .then(publishAnswerPreview)
      .finally(() => {
        answerPreviewPending = false;
        if (answerPreviewEnabled && answerPreviewDirty && !isAborted?.()) queueAnswerPreview(true);
      });
    answerPreviewUpdates.push(answerPreviewChain);
  };

  const waitForAnswerPreview = async (): Promise<void> => {
    while (answerPreviewEnabled && (answerPreviewPending || answerPreviewDirty)) {
      if (!answerPreviewPending && answerPreviewDirty) queueAnswerPreview(true);
      await Promise.allSettled([...answerPreviewUpdates]);
    }
  };

  const discardAnswerPreview = async (): Promise<void> => {
    if (answerPreviewTimer) {
      clearTimeout(answerPreviewTimer);
      answerPreviewTimer = null;
    }
    await Promise.allSettled(answerPreviewUpdates);
    if (answerPreviewMessageId == null || typeof client.deleteMessage !== "function") return;
    try {
      await client.deleteMessage({ chat_id: chatId, message_id: answerPreviewMessageId });
    } catch {
      // The provider attempt is already abandoned; cleanup is best effort.
    }
    answerPreviewMessageId = null;
  };

  const onAnswerDelta = (delta: string): void => {
    if (!answerPreviewEnabled || !delta || isAborted?.()) return;
    answerPreviewText += delta;
    queueAnswerPreview(answerPreviewMessageId == null);
  };

  const wrappedOnProgress = (chunk: string) => {
    currentText += chunk;
    originalOnProgress?.(chunk);

    if (streamingEnabled) {
      // Throttle typing refreshes: Telegram's typing status lasts ~5s and the
      // background typingInterval already refreshes it, so per-chunk sends
      // would only spam the API on chatty streams.
      const nowTyping = Date.now();
      if (nowTyping - lastTypingSentMs >= TYPING_REFRESH_INTERVAL_MS) {
        lastTypingSentMs = nowTyping;
        void sendTyping();
      }
      if (!showProgressNarration) return;
      const now = Date.now();
      if (now - lastProgressEditMs >= PROGRESS_EDIT_INTERVAL_MS) {
        lastProgressEditMs = now;
        const previewText = truncate(extractStatusProgress(currentText));
        if (!previewText) return;
        if (previewText === lastSentPreviewText) return;
        lastSentPreviewText = previewText;
        if (progressMsgId == null) {
          if (progressMsgPending) return;
          progressMsgPending = true;
          const update = client.sendMessage({ chat_id: chatId, ...body, text: previewText })
            .then((sent: any) => { progressMsgId = sent?.result?.message_id ?? null; })
            .catch(() => { /* ignore send failures during streaming */ })
            .finally(() => { progressMsgPending = false; });
          progressUpdates.push(update);
          return;
        }
        const update = client.editMessageText({
          chat_id: chatId,
          message_id: progressMsgId,
          ...body,
          text: previewText,
        }).catch(() => { /* ignore edit failures during streaming */ });
        progressUpdates.push(update);
      }
    }
  };

  async function deliverFinal(text: string): Promise<void> {
    await Promise.allSettled(progressUpdates);
    if (answerPreviewTimer) {
      clearTimeout(answerPreviewTimer);
      answerPreviewTimer = null;
    }
    if (answerPreviewEnabled && answerPreviewText.trim()) {
      answerPreviewDirty = true;
      queueAnswerPreview(true);
    }
    await waitForAnswerPreview();
    if (answerPreviewEnabled && answerPreviewMessageId != null
      && text.length <= MAX_TELEGRAM_TEXT
      && routeNativeLayout(text, { documentEnabled: documentFallbackEnabled() }).kind === "plain") {
      try {
        await client.editMessageText({
          chat_id: chatId,
          ...body,
          message_id: answerPreviewMessageId,
          ...renderAnswerPreview(text),
        });
        return;
      } catch {
        answerPreviewEnabled = false;
      }
    }
    if (streamingEnabled && progressMsgId != null) {
      try {
        await client.editMessageText({
          chat_id: chatId,
          message_id: progressMsgId,
          ...body,
          text: renderTelegramHtml(truncate(text)),
          parse_mode: "HTML",
        });
        return;
      } catch (editErr: any) {
        const msg = String(editErr?.message ?? editErr);
        if (msg.includes("message is not modified")) return;
        /* fall through to sendTelegramMessage if edit fails */
      }
    }
    await sendTelegramMessage({ client, kind, chatId, body: { ...body, text } });
  }

  let finalDeliveryPreparationFailed = false;
  let finalDeliveryCompleted = false;
  try {
    let result: any;
    if (typeof execution === "function") {
      result = await execution(wrappedOnProgress, onAnswerDelta);
    } else {
      result = await execution;
    }

    const finalText = result?.text || currentText || "";
    const cliResult = result == null
      ? null
      : { text: result.text, sessionId: result.sessionId ?? null };

    if (isAborted?.()) {
      clearInterval(typingInterval);
      return null;
    }

    validateParity({
      kind,
      chatId,
      runId,
      finalText,
      sessionId: result?.sessionId,
    });

    try {
      if (beforeFinalDelivery?.() === false) {
        clearInterval(typingInterval);
        return null;
      }
    } catch (err) {
      finalDeliveryPreparationFailed = true;
      throw err;
    }
    await deliverFinal(finalText);
    finalDeliveryCompleted = true;
    await afterFinalDelivery?.();

    clearInterval(typingInterval);
    return cliResult;
  } catch (err: any) {
    clearInterval(typingInterval);
    if (!finalDeliveryCompleted) await discardAnswerPreview();
    if (isAborted?.()) return null;
    if (propagateExecutionErrors && !finalDeliveryPreparationFailed) throw err;
    if (finalDeliveryPreparationFailed) throw err;
    if (isCapacityExhaustedError(err instanceof Error ? err : new Error(String(err)))) {
      throw err;
    }
    const errorText = `❌ ${toUserMessage(err instanceof Error ? err : new Error(String(err)))}`;
    validateParity({
      kind,
      chatId,
      runId,
      errorText,
    });
    await deliverFinal(errorText);
    console.error(`[${kind}] execution error`, err);
    return null;
  }
}
