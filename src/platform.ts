/** Explicit messaging-surface contract shared by runtime delivery policy and adapters. */
export type TransportRequest = Record<string, unknown>;
export type TransportResponse = any;

export type SurfaceFormattingDialect = "telegram-html" | "discord-markdown" | "plain";
export interface SurfaceCapabilities {
  maxMessageLength: number;
  editMessages: boolean;
  deleteMessages: boolean;
  previewStreaming: boolean;
  threads: boolean;
  attachments: boolean;
  typing: boolean;
  polling: boolean;
  remoteFileDownload: boolean;
  richMessages: boolean;
  formatting: SurfaceFormattingDialect;
}

export const SAFE_SURFACE_CAPABILITIES: SurfaceCapabilities = Object.freeze({
  maxMessageLength: 2000,
  editMessages: false,
  deleteMessages: false,
  previewStreaming: false,
  threads: false,
  attachments: false,
  typing: false,
  polling: false,
  remoteFileDownload: false,
  richMessages: false,
  formatting: "plain",
});

export const TELEGRAM_SURFACE_CAPABILITIES: SurfaceCapabilities = Object.freeze({
  maxMessageLength: 4096,
  editMessages: true,
  deleteMessages: true,
  previewStreaming: true,
  threads: true,
  attachments: true,
  typing: true,
  polling: true,
  remoteFileDownload: true,
  richMessages: true,
  formatting: "telegram-html",
});

export const DISCORD_SURFACE_CAPABILITIES: SurfaceCapabilities = Object.freeze({
  maxMessageLength: 1990,
  editMessages: true,
  deleteMessages: false,
  previewStreaming: false,
  threads: false,
  attachments: true,
  typing: true,
  polling: false,
  remoteFileDownload: false,
  richMessages: false,
  formatting: "discord-markdown",
});

export interface MessagingPlatform {
  readonly capabilities?: SurfaceCapabilities;
  getUpdates?(options: TransportRequest): Promise<TransportResponse>;
  sendMessage(body: TransportRequest): Promise<TransportResponse>;
  sendRichMessage?(body: TransportRequest): Promise<TransportResponse>;
  sendRichMessageDraft?(body: TransportRequest): Promise<TransportResponse>;
  editMessageText(body: TransportRequest): Promise<TransportResponse>;
  deleteMessage?(body: TransportRequest): Promise<TransportResponse>;
  sendChatAction(body: TransportRequest): Promise<TransportResponse>;
  answerCallbackQuery(body: TransportRequest): Promise<TransportResponse>;
  setMyCommands(body: TransportRequest): Promise<TransportResponse>;
  sendDocument(chatId: number | string, filePath: string, caption?: string, options?: FileSendOptions): Promise<void>;
  sendDocumentBuffer?(body: { chat_id: number | string; bytes: Buffer; filename: string; mime_type?: string; caption?: string; [key: string]: any }): Promise<any>;
  sendPhoto(chatId: number | string, filePath: string, caption?: string, options?: FileSendOptions): Promise<void>;
  getFilePath?(fileId: string): Promise<string>;
  downloadFile?(filePath: string, destPath: string): Promise<void>;
}

export interface FileSendOptions { message_thread_id?: number | string; }

export type MessagingPlatformKind = "telegram" | "discord";

export interface SurfaceIdentity {
  kind: MessagingPlatformKind;
  accountId: string;
}

export function formatSurfaceIdentity(identity: SurfaceIdentity): string {
  return `${identity.kind}:${identity.accountId}`;
}

export function parseSurfaceIdentity(identity: string): SurfaceIdentity | null {
  const separator = identity.indexOf(":");
  if (separator <= 0 || separator === identity.length - 1) return null;
  const kind = identity.slice(0, separator);
  if (kind !== "telegram" && kind !== "discord") return null;
  return { kind, accountId: identity.slice(separator + 1) };
}

export function surfaceCapabilities(platform: MessagingPlatform): SurfaceCapabilities {
  const candidate = platform.capabilities;
  if (!candidate || typeof candidate !== "object") return SAFE_SURFACE_CAPABILITIES;
  const booleanKeys: Array<keyof SurfaceCapabilities> = [
    "editMessages", "deleteMessages", "previewStreaming", "threads", "attachments",
    "typing", "polling", "remoteFileDownload", "richMessages",
  ];
  if (!Number.isSafeInteger(candidate.maxMessageLength) || candidate.maxMessageLength <= 0) return SAFE_SURFACE_CAPABILITIES;
  if (booleanKeys.some((key) => typeof candidate[key] !== "boolean")) return SAFE_SURFACE_CAPABILITIES;
  if (candidate.formatting !== "telegram-html" && candidate.formatting !== "discord-markdown" && candidate.formatting !== "plain") return SAFE_SURFACE_CAPABILITIES;
  return candidate;
}
