import { mkdir, readdir, unlink, rm, chmod, readFile, writeFile } from "node:fs/promises";
import { join, extname, basename } from "node:path";
import { surfaceCapabilities, type FileSendOptions, type MessagingPlatform } from "./platform.js";

const BRIDGE_OUT_BASE = "/tmp/bridge-out";
const PRIVATE_DIR_MODE = 0o700;
const RETENTION_MARKER = ".delivery-retained.json";
const FAILED_OUTPUT_RETENTION_MS = 24 * 60 * 60 * 1000;

export interface OutputDeliveryResult {
  status: "complete" | "partial" | "cancelled" | "unsupported";
  uploadedFiles: string[];
  failedFiles: string[];
  retainedUntil: string | null;
}

export async function cleanupExpiredRetainedOutputDirs(nowMs = Date.now()): Promise<void> {
  let entries;
  try {
    entries = await readdir(BRIDGE_OUT_BASE, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(BRIDGE_OUT_BASE, entry.name);
    try {
      const marker = JSON.parse(await readFile(join(dir, RETENTION_MARKER), "utf8")) as { expiresAt?: unknown };
      const expiresAt = typeof marker.expiresAt === "string" ? Date.parse(marker.expiresAt) : Number.NaN;
      if (Number.isFinite(expiresAt) && expiresAt <= nowMs) {
        await rm(dir, { recursive: true, force: true });
      }
    } catch {
      // Only directories carrying a valid retention marker are lifecycle-owned here.
    }
  }
}

export async function prepareOutputDir(chatId: number | string, kind: string, runId?: string): Promise<string> {
  await cleanupExpiredRetainedOutputDirs();
  const dir = join(BRIDGE_OUT_BASE, `${kind}-${String(chatId)}${runId ? `-${runId}` : ""}`);
  // Wipe any files left by a previous partial run before handing the dir to the CLI.
  await rm(dir, { recursive: true, force: true });
  // The shared parent may be used by more than one service account. Restrict
  // only the uniquely owned run directory, not the common /tmp container.
  await mkdir(BRIDGE_OUT_BASE, { recursive: true });
  await mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  await chmod(dir, PRIVATE_DIR_MODE);
  return dir;
}

export async function collectOutputFiles(outDir: string): Promise<string[]> {
  try {
    const entries = await readdir(outDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name !== RETENTION_MARKER)
      .map((entry) => join(outDir, entry.name));
  } catch {
    return [];
  }
}

export async function cleanOutputDir(outDir: string): Promise<void> {
  await rm(outDir, { recursive: true, force: true });
}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

async function notifyPartialDelivery(
  client: Pick<MessagingPlatform, "sendPhoto" | "sendDocument"> & Partial<Pick<MessagingPlatform, "sendMessage">>,
  chatId: number | string,
  failedCount: number,
  retainedUntil: string,
  options?: FileSendOptions,
): Promise<void> {
  if (typeof client.sendMessage !== "function") return;
  const noun = failedCount === 1 ? "file" : "files";
  try {
    await client.sendMessage({
      chat_id: chatId,
      ...(options ?? {}),
      text: `⚠️ ${failedCount} generated ${noun} could not be delivered. ${failedCount === 1 ? "It has" : "They have"} been retained for retry until ${retainedUntil}.`,
    });
  } catch (error) {
    console.error("[fileOutput] failed to notify partial artifact delivery:", error);
  }
}

export async function uploadOutputFiles(
  outDir: string,
  chatId: number | string,
  client: Pick<MessagingPlatform, "sendPhoto" | "sendDocument"> & Partial<Pick<MessagingPlatform, "sendMessage">>,
  options?: FileSendOptions,
  canPublish: () => boolean = () => true,
): Promise<OutputDeliveryResult> {
  const files = await collectOutputFiles(outDir);
  const capabilities = surfaceCapabilities(client as MessagingPlatform);
  if (!capabilities.attachments || typeof client.sendPhoto !== "function" || typeof client.sendDocument !== "function") {
    await cleanOutputDir(outDir);
    return {
      status: "unsupported",
      uploadedFiles: [],
      failedFiles: files.map((filePath) => basename(filePath)),
      retainedUntil: null,
    };
  }
  if (files.length > 0) {
    console.log(`[fileOutput] uploading ${files.length} file(s) for chatId=${chatId}: ${files.map((f) => basename(f)).join(", ")}`);
  }
  const uploadedFiles: string[] = [];
  const failedPaths: string[] = [];
  for (const filePath of files) {
    if (!canPublish()) {
      await cleanOutputDir(outDir);
      return {
        status: "cancelled",
        uploadedFiles,
        failedFiles: [],
        retainedUntil: null,
      };
    }
    const ext = extname(filePath).toLowerCase();
    try {
      if (IMAGE_EXTENSIONS.has(ext)) {
        await client.sendPhoto(chatId, filePath, undefined, options);
      } else {
        await client.sendDocument(chatId, filePath, undefined, options);
      }
      const name = basename(filePath);
      uploadedFiles.push(name);
      console.log(`[fileOutput] uploaded ${name}`);
      await unlink(filePath).catch(() => {/* ignore if already gone */});
    } catch (err) {
      failedPaths.push(filePath);
      console.error(`[fileOutput] upload failed for ${basename(filePath)}:`, err);
    }
  }
  if (!canPublish()) {
    await cleanOutputDir(outDir);
    return {
      status: "cancelled",
      uploadedFiles,
      failedFiles: [],
      retainedUntil: null,
    };
  }
  if (failedPaths.length > 0) {
    const retainedUntil = new Date(Date.now() + FAILED_OUTPUT_RETENTION_MS).toISOString();
    await writeFile(join(outDir, RETENTION_MARKER), `${JSON.stringify({ expiresAt: retainedUntil })}\n`, { mode: 0o600 });
    await notifyPartialDelivery(client, chatId, failedPaths.length, retainedUntil, options);
    return {
      status: "partial",
      uploadedFiles,
      failedFiles: failedPaths.map((filePath) => basename(filePath)),
      retainedUntil,
    };
  }
  await cleanOutputDir(outDir);
  return {
    status: "complete",
    uploadedFiles,
    failedFiles: [],
    retainedUntil: null,
  };
}
