import { mkdir, chmod } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { TelegramMessage } from "./types.js";
import type { MessagingPlatform } from "./platform.js";

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB — Telegram bot API limit
const PRIVATE_DIR_MODE = 0o700;

const MIME_MAP: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".json": "application/json",
};

export function mimeTypeFromExtension(filename: string): string {
  const ext = extname(filename).toLowerCase();
  return MIME_MAP[ext] ?? "application/octet-stream";
}

export interface AttachmentInfo {
  localPath: string;
  mimeType: string;
}

function resolveContainedUploadPath(destDir: string, fileName: string): string | null {
  if (!fileName || fileName.includes("\0") || fileName.includes("/") || fileName.includes("\\")) {
    return null;
  }
  const root = resolve(destDir);
  const candidate = resolve(root, fileName);
  const rel = relative(root, candidate);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return candidate;
}

export async function downloadTelegramAttachment(
  client: Pick<MessagingPlatform, "getFilePath" | "downloadFile">,
  message: TelegramMessage,
  destDir: string,
  fileNamePrefix = "",
): Promise<AttachmentInfo | null> {
  await mkdir(destDir, { recursive: true, mode: PRIVATE_DIR_MODE });
  await chmod(destDir, PRIVATE_DIR_MODE);

  if (message.photo && message.photo.length > 0) {
    const largest = message.photo[message.photo.length - 1];
    if (largest.file_size !== undefined && largest.file_size > MAX_FILE_SIZE) {
      return null;
    }
    const fileName = `${fileNamePrefix}photo_${largest.file_id}.jpg`;
    const localPath = resolveContainedUploadPath(destDir, fileName);
    if (!localPath) return null;
    try {
      const filePath = await client.getFilePath(largest.file_id);
      await client.downloadFile(filePath, localPath);
      return { localPath, mimeType: "image/jpeg" };
    } catch {
      return null;
    }
  }

  if (message.document) {
    const doc = message.document;
    if (doc.file_size !== undefined && doc.file_size > MAX_FILE_SIZE) {
      return null;
    }
    const displayFileName = doc.file_name ?? `document_${doc.file_id}`;
    const fileName = `${fileNamePrefix}${displayFileName}`;
    const localPath = resolveContainedUploadPath(destDir, fileName);
    if (!localPath) return null;
    try {
      const filePath = await client.getFilePath(doc.file_id);
      await client.downloadFile(filePath, localPath);
      const mimeType = doc.mime_type ?? mimeTypeFromExtension(displayFileName);
      return { localPath, mimeType };
    } catch {
      return null;
    }
  }

  return null;
}
