/**
 * MessagingPlatform — minimal interface shared by TelegramClient and future Discord/other clients.
 * BridgeEngine accepts this interface so it can be wired with any conforming transport.
 */
/**
 * Transport request payload. Transport-shaped (Telegram/Discord) fields stay at
 * the adapter boundary; runtime code passes plain keyed objects.
 */
export type TransportRequest = Record<string, unknown>;

/**
 * Transport response. Responses remain transport-shaped; callers narrow the
 * fields they read (e.g. Telegram's `result.message_id`) at the call site.
 */
export type TransportResponse = any;

export interface MessagingPlatform {
  // Polling (Telegram long-poll; Discord implementations should stub / no-op)
  getUpdates(options: TransportRequest): Promise<TransportResponse>;
  // Core messaging
  sendMessage(body: TransportRequest): Promise<TransportResponse>;
  sendRichMessage?(body: TransportRequest): Promise<TransportResponse>;
  sendRichMessageDraft?(body: TransportRequest): Promise<TransportResponse>;
  editMessageText(body: TransportRequest): Promise<TransportResponse>;
  deleteMessage?(body: TransportRequest): Promise<TransportResponse>;
  sendChatAction(body: TransportRequest): Promise<TransportResponse>;
  answerCallbackQuery(body: TransportRequest): Promise<TransportResponse>;
  // Bot metadata
  setMyCommands(body: TransportRequest): Promise<TransportResponse>;
  // File delivery
  sendDocument(chatId: number | string, filePath: string, caption?: string, options?: FileSendOptions): Promise<void>;
  sendDocumentBuffer?(body: {
    chat_id: number | string;
    bytes: Buffer;
    filename: string;
    mime_type?: string;
    caption?: string;
    [key: string]: any;
  }): Promise<any>;
  sendPhoto(chatId: number | string, filePath: string, caption?: string, options?: FileSendOptions): Promise<void>;
  // Attachment download (Telegram-specific; Discord stubs may throw or no-op)
  getFilePath(fileId: string): Promise<string>;
  downloadFile(filePath: string, destPath: string): Promise<void>;
}

export interface FileSendOptions {
  message_thread_id?: number;
}
