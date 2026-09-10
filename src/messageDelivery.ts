import { splitTelegramText, toTelegramEntitiesText } from "./render.js";
import { toUserMessage, isCapacityExhaustedError, CliTimeoutError } from "./cli.js";
import { surfaceCapabilities, type MessagingPlatform } from "./platform.js";
import type { CliResult } from "./types.js";
import { runActivityText, type ProgressReporter, type RunActivity } from "./runActivity.js";
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
const ANSWER_PREVIEW_ABORT_POLL_MS = 50;
const RUN_ACTIVITY_EDIT_INTERVAL_MS = 700;

export class PreviewCleanupError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super("failed to remove an abandoned answer preview");
    this.name = "PreviewCleanupError";
    this.cause = cause;
  }
}

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

function isTelegramMessageNotModified(error: unknown): boolean {
  const message = String((error as any)?.message ?? error);
  return message.includes("message is not modified");
}

export async function sendTelegramMessage({
  client,
  kind,
  chatId,
  body,
}: {
  client: MessagingPlatform;
  kind: string;
  chatId: number | string;
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

export async function sendSurfaceMessage({ client, kind, chatId, body }: { client: MessagingPlatform; kind: string; chatId: number | string; body: any }): Promise<number | string | null> {
  const capabilities = surfaceCapabilities(client);
  if (capabilities.formatting === "telegram-html") {
    const numericChatId = typeof chatId === "number" ? chatId : Number(chatId);
    if (!Number.isSafeInteger(numericChatId)) throw new Error("Telegram delivery requires a numeric chat id");
    return sendTelegramMessage({ client, kind, chatId: numericChatId, body });
  }
  const response = await client.sendMessage({ chat_id: chatId, ...body });
  return response?.result?.message_id ?? response?.id ?? null;
}

async function sendEntityMessages({
  client,
  chatId,
  body,
}: {
  client: MessagingPlatform;
  chatId: number | string;
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
  chatId: number | string;
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
        chatKey: String(chatId),
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
          chatKey: String(chatId),
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
          chatKey: String(chatId),
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
  allowAnswerPreview,
  isAborted,
  beforeFinalDelivery,
  afterFinalDelivery,
  propagateExecutionErrors = false,
  propagateTimeoutErrors = false,
  runId,
  onEvent,
}: {
  client: MessagingPlatform;
  kind: string;
  chatId: number | string;
  execution: ((onProgress: ProgressReporter, onAnswerDelta: (text: string) => void) => Promise<CliResult>) | Promise<CliResult>;
  onProgress?: ProgressReporter;
  body?: any;
  showProgressNarration?: boolean;
  /** Provider-neutral opt-in for safe provisional answer deltas. */
  allowAnswerPreview?: boolean;
  isAborted?: () => boolean;
  beforeFinalDelivery?: () => boolean;
  afterFinalDelivery?: () => void | Promise<void>;
  propagateExecutionErrors?: boolean;
  propagateTimeoutErrors?: boolean;
  runId?: string;
  onEvent?: (event: BridgeEvent) => void;
}): Promise<CliResult | null> {
  const { text: _ignored, ...rest } = body;
  const capabilities = surfaceCapabilities(client);

  const sendTyping = async () => {
    if (isAborted?.() || !capabilities.typing) return;
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
  let answerPreviewEnabled = (allowAnswerPreview ?? (kind === "claude" || kind === "antigravity"))
    && capabilities.previewStreaming && capabilities.editMessages && capabilities.deleteMessages
    && typeof client.deleteMessage === "function";
  let answerPreviewMessageId: number | null = null;
  let answerPreviewText = "";
  let answerPreviewDirty = false;
  let answerPreviewPending = false;
  let answerPreviewTimer: NodeJS.Timeout | null = null;
  let answerPreviewChain = Promise.resolve();
  let lastAnswerPreviewEditMs = 0;
  const answerPreviewUpdates: Promise<unknown>[] = [];

  let progressMsgId: number | string | null = null;
  let progressPublishPending = false;
  let progressTimer: NodeJS.Timeout | null = null;
  let pendingProgressText: string | null = null;
  let pendingProgressIntervalMs = RUN_ACTIVITY_EDIT_INTERVAL_MS;
  let progressStopped = false;
  let progressCleanup: Promise<void> | null = null;
  let progressChain = Promise.resolve();
  const progressUpdates: Promise<unknown>[] = [];

  let currentText = "";
  let lastProgressEditMs = 0;
  let lastSentPreviewText = "";
  let lastTypingSentMs = Date.now();
  const PROGRESS_EDIT_INTERVAL_MS = 5_000;
  const TYPING_REFRESH_INTERVAL_MS = 4_000;
  const originalOnProgress = onProgress;

  const renderAnswerPreview = (text: string): any => {
    const maxLength = capabilities.maxMessageLength;
    const bounded = text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
    if (capabilities.formatting !== "telegram-html") return { text: bounded };
    try { return { text: renderTelegramHtml(bounded), parse_mode: "HTML" }; } catch { return { text: bounded }; }
  };

  const publishProgressText = async (text: string): Promise<void> => {
    if (progressStopped || isAborted?.() || !text || text === lastSentPreviewText) return;
    try {
      if (progressMsgId == null) {
        const sent = await client.sendMessage({ chat_id: chatId, ...body, text });
        const messageId = sent?.result?.message_id ?? sent?.id;
        if (typeof messageId !== "number" && typeof messageId !== "string") return;
        progressMsgId = messageId;
      } else {
        await client.editMessageText({
          chat_id: chatId,
          message_id: progressMsgId,
          ...body,
          text,
        });
      }
      lastSentPreviewText = text;
      lastProgressEditMs = Date.now();
    } catch (error) {
      if (isTelegramMessageNotModified(error)) {
        lastSentPreviewText = text;
        lastProgressEditMs = Date.now();
      }
      // Transient activity must never fail the Run.
    }
  };

  const startProgressPublish = (): void => {
    if (progressPublishPending || progressStopped || !pendingProgressText) return;
    const text = pendingProgressText;
    pendingProgressText = null;
    progressPublishPending = true;
    progressChain = progressChain
      .then(() => publishProgressText(text))
      .finally(() => {
        progressPublishPending = false;
        if (pendingProgressText && !progressStopped && !isAborted?.()) {
          const elapsed = Date.now() - lastProgressEditMs;
          const delay = progressMsgId == null ? 0 : Math.max(0, pendingProgressIntervalMs - elapsed);
          if (delay === 0) startProgressPublish();
          else if (!progressTimer) {
            progressTimer = setTimeout(() => {
              progressTimer = null;
              startProgressPublish();
            }, delay);
            progressTimer.unref();
          }
        }
      });
    progressUpdates.push(progressChain);
  };

  const queueProgressText = (text: string, minIntervalMs: number): void => {
    if (progressStopped || isAborted?.() || !text) return;
    if (text === lastSentPreviewText || text === pendingProgressText) return;
    pendingProgressText = text;
    pendingProgressIntervalMs = minIntervalMs;
    if (progressPublishPending) return;
    const elapsed = Date.now() - lastProgressEditMs;
    const delay = progressMsgId == null ? 0 : Math.max(0, minIntervalMs - elapsed);
    if (delay === 0) {
      startProgressPublish();
      return;
    }
    if (!progressTimer) {
      progressTimer = setTimeout(() => {
        progressTimer = null;
        startProgressPublish();
      }, delay);
      progressTimer.unref();
    }
  };

  const discardProgress = async (): Promise<void> => {
    progressStopped = true;
    pendingProgressText = null;
    if (progressTimer) {
      clearTimeout(progressTimer);
      progressTimer = null;
    }
    await Promise.allSettled([...progressUpdates, progressChain]);
    if (progressMsgId == null) return;
    const messageId = progressMsgId;
    if (typeof client.deleteMessage === "function" && capabilities.deleteMessages) {
      try {
        await client.deleteMessage({ chat_id: chatId, message_id: messageId });
        if (progressMsgId === messageId) progressMsgId = null;
        return;
      } catch {
        /* fall through to a neutral terminal edit when supported */
      }
    }
    if (!capabilities.editMessages) return;
    try {
      await client.editMessageText({ chat_id: chatId, message_id: messageId, ...body, text: "Stopped." });
      lastSentPreviewText = "Stopped.";
    } catch {
      /* transient cleanup failure must not fail the Run */
    }
  };

  const beginProgressCleanup = (): Promise<void> => {
    progressStopped = true;
    if (!progressCleanup) progressCleanup = discardProgress();
    return progressCleanup;
  };

  const publishAnswerPreview = async (): Promise<void> => {
    if (progressCleanup) await progressCleanup;
    if (isAborted?.()) {
      answerPreviewDirty = false;
      return;
    }
    if (!answerPreviewEnabled || !answerPreviewDirty || !answerPreviewText.trim()) return;
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
    } catch (error) {
      if (isTelegramMessageNotModified(error)) {
        lastAnswerPreviewEditMs = Date.now();
        return;
      }
      answerPreviewEnabled = false;
      answerPreviewDirty = false;
    }
  };

  const queueAnswerPreview = (immediate = false): void => {
    if (isAborted?.()) {
      answerPreviewDirty = false;
      return;
    }
    if (!answerPreviewEnabled || !answerPreviewText.trim()) return;
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
      if (isAborted?.()) {
        answerPreviewDirty = false;
        answerPreviewEnabled = false;
        return;
      }
      if (!answerPreviewPending && answerPreviewDirty) queueAnswerPreview(true);
      let fenceTimer: NodeJS.Timeout | null = null;
      const fencePoll = new Promise<void>((resolve) => {
        fenceTimer = setTimeout(resolve, ANSWER_PREVIEW_ABORT_POLL_MS);
        fenceTimer.unref();
      });
      await Promise.race([
        Promise.allSettled([...answerPreviewUpdates]),
        fencePoll,
      ]);
      if (fenceTimer) clearTimeout(fenceTimer);
    }
  };

  const deleteAnswerPreview = async (strict: boolean): Promise<void> => {
    if (answerPreviewMessageId == null || typeof client.deleteMessage !== "function") return;
    const messageId = answerPreviewMessageId;
    try {
      await client.deleteMessage({ chat_id: chatId, message_id: messageId });
    } catch (error) {
      if (strict) throw new PreviewCleanupError(error);
      console.warn(`[${kind}] failed to remove a late abandoned answer preview`, error);
      return;
    }
    if (answerPreviewMessageId === messageId) answerPreviewMessageId = null;
  };

  const discardAnswerPreview = async (): Promise<void> => {
    if (answerPreviewTimer) {
      clearTimeout(answerPreviewTimer);
      answerPreviewTimer = null;
    }
    answerPreviewDirty = false;
    // Once a preview is abandoned, its provisional text must not be reused
    // by later error/fallback/fence delivery in this turn.
    answerPreviewText = "";
    const aborted = isAborted?.() === true;
    if (aborted) answerPreviewEnabled = false;
    const pendingUpdates = [...answerPreviewUpdates];
    if (aborted) {
      void Promise.allSettled(pendingUpdates)
        .then(() => deleteAnswerPreview(false))
        .catch(() => {});
      return;
    }
    await Promise.allSettled(pendingUpdates);
    await deleteAnswerPreview(true);
  };

  const onAnswerDelta = (delta: string): void => {
    if (!answerPreviewEnabled || !delta || isAborted?.()) return;
    void beginProgressCleanup();
    answerPreviewText += delta;
    queueAnswerPreview(answerPreviewMessageId == null);
  };

  const wrappedOnProgress = ((chunk: string) => {
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
      const previewText = truncate(extractStatusProgress(currentText));
      if (!previewText) return;
      queueProgressText(previewText, PROGRESS_EDIT_INTERVAL_MS);
    }
  }) as ProgressReporter;

  wrappedOnProgress.activity = (activity: RunActivity): void => {
    originalOnProgress.activity?.(activity);
    if (progressStopped || isAborted?.()) return;
    queueProgressText(truncate(runActivityText(activity)), RUN_ACTIVITY_EDIT_INTERVAL_MS);
  };

  async function deliverFinal(text: string): Promise<void> {
    progressStopped = true;
    pendingProgressText = null;
    if (progressTimer) {
      clearTimeout(progressTimer);
      progressTimer = null;
    }
    await Promise.allSettled([...progressUpdates, progressChain]);
    if (progressCleanup) await progressCleanup;
    if (answerPreviewTimer) {
      clearTimeout(answerPreviewTimer);
      answerPreviewTimer = null;
    }
    if (answerPreviewEnabled && answerPreviewText.trim()) {
      answerPreviewDirty = true;
      queueAnswerPreview(true);
    }
    await waitForAnswerPreview();
    if (isAborted?.()) throw new Error("answer delivery aborted");
    if (answerPreviewEnabled && answerPreviewMessageId != null
      && capabilities.editMessages
      && text.length <= capabilities.maxMessageLength
      && routeNativeLayout(text, { documentEnabled: documentFallbackEnabled() }).kind === "plain") {
      try {
        await client.editMessageText({
          chat_id: chatId,
          ...body,
          message_id: answerPreviewMessageId,
          ...renderAnswerPreview(text),
        });
        return;
      } catch (editErr: any) {
        if (isTelegramMessageNotModified(editErr)) return;
        answerPreviewEnabled = false;
      }
    }
    if (answerPreviewMessageId != null) {
      await deleteAnswerPreview(true);
      answerPreviewEnabled = false;
    }
    if (capabilities.editMessages && progressMsgId != null
      && text.length <= capabilities.maxMessageLength
      && routeNativeLayout(text, { documentEnabled: documentFallbackEnabled() }).kind === "plain") {
      try {
        await client.editMessageText({
          chat_id: chatId,
          message_id: progressMsgId,
          ...body,
          ...renderAnswerPreview(text),
        });
        return;
      } catch (editErr: any) {
        if (isTelegramMessageNotModified(editErr)) return;
        /* fall through to cleanup + normal final delivery */
      }
    }
    if (progressMsgId != null && typeof client.deleteMessage === "function" && capabilities.deleteMessages) {
      try {
        await client.deleteMessage({ chat_id: chatId, message_id: progressMsgId });
        progressMsgId = null;
      } catch {
        /* stale transient cleanup is best-effort before normal final delivery */
      }
    }
    await sendSurfaceMessage({ client, kind, chatId, body: { ...body, text } });
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
      await Promise.all([discardAnswerPreview(), beginProgressCleanup()]);
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
        await Promise.all([discardAnswerPreview(), beginProgressCleanup()]);
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
    if (isAborted?.()) {
      await beginProgressCleanup();
      return null;
    }
    if (propagateTimeoutErrors && err instanceof CliTimeoutError) {
      await beginProgressCleanup();
      throw err;
    }
    if (propagateExecutionErrors && !finalDeliveryPreparationFailed) {
      await beginProgressCleanup();
      throw err;
    }
    if (finalDeliveryPreparationFailed) {
      await beginProgressCleanup();
      throw err;
    }
    if (isCapacityExhaustedError(err instanceof Error ? err : new Error(String(err)))) {
      await beginProgressCleanup();
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
