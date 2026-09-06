import { mkdir, readdir, unlink, rm, chmod, readFile, writeFile } from "node:fs/promises";
import { join, extname, basename } from "node:path";
import { surfaceCapabilities, type FileSendOptions, type MessagingPlatform } from "./platform.js";

const BRIDGE_OUT_BASE = "/tmp/bridge-out";
const PRIVATE_DIR_MODE = 0o700;
const RETENTION_MARKER = ".delivery-retained.json";
const FAILED_OUTPUT_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_TIMER_DELAY_MS = 2_147_000_000;
const retentionTimers = new Map<string, NodeJS.Timeout>();

export interface OutputDeliveryResult {
  status: "complete" | "partial" | "cancelled" | "unsupported";
  uploadedFiles: string[];
  failedFiles: string[];
  retainedUntil: string | null;
}

type RetentionMarkerState =
  | { state: "missing" }
  | { state: "unavailable" }
  | { state: "invalid" }
  | { state: "valid"; expiresAt: string; expiresAtMs: number };

async function readRetentionMarker(outDir: string): Promise<RetentionMarkerState> {
  let raw: string;
  try {
    raw = await readFile(join(outDir, RETENTION_MARKER), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { state: "missing" };
    // BRIDGE_OUT_BASE can be shared by multiple service accounts. A marker
    // that this process cannot read is not evidence that it owns the sibling
    // directory or that the marker is malformed.
    return { state: "unavailable" };
  }
  try {
    const marker = JSON.parse(raw) as { expiresAt?: unknown };
    if (typeof marker.expiresAt !== "string") return { state: "invalid" };
    const expiresAtMs = Date.parse(marker.expiresAt);
    if (!Number.isFinite(expiresAtMs)) return { state: "invalid" };
    return { state: "valid", expiresAt: marker.expiresAt, expiresAtMs };
  } catch {
    return { state: "invalid" };
  }
}

function clearRetentionTimer(outDir: string): void {
  const timer = retentionTimers.get(outDir);
  if (!timer) return;
  clearTimeout(timer);
  retentionTimers.delete(outDir);
}

function scheduleRetainedOutputCleanup(outDir: string, expiresAtMs: number): void {
  clearRetentionTimer(outDir);
  const delay = Math.max(0, Math.min(expiresAtMs - Date.now(), MAX_TIMER_DELAY_MS));
  const timer = setTimeout(() => {
    retentionTimers.delete(outDir);
    void rm(outDir, { recursive: true, force: true }).catch((error) => {
      console.error(`[fileOutput] failed to expire retained output ${basename(outDir)}:`, error);
    });
  }, delay);
  timer.unref();
  retentionTimers.set(outDir, timer);
}

async function sweepRemoveRetainedDir(dir: string): Promise<void> {
  clearRetentionTimer(dir);
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== "EACCES" && code !== "EPERM") {
      console.error(`[fileOutput] failed to sweep retained output ${basename(dir)}:`, error);
    }
  }
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
    const marker = await readRetentionMarker(dir);
    if (marker.state === "missing" || marker.state === "unavailable") continue;
    if (marker.state === "invalid" || marker.expiresAtMs <= nowMs) {
      await sweepRemoveRetainedDir(dir);
      continue;
    }
    scheduleRetainedOutputCleanup(dir, marker.expiresAtMs);
  }
}

// The module is loaded once per messaging service process. Sweep retained
// output on startup/restart, then per-directory timers enforce expiry while
// the process remains alive. prepareOutputDir also sweeps as a recovery seam.
void cleanupExpiredRetainedOutputDirs().catch((error) => {
  console.error("[fileOutput] retained output startup cleanup failed:", error);
});

export async function prepareOutputDir(chatId: number | string, kind: string, runId?: string): Promise<string> {
  await cleanupExpiredRetainedOutputDirs();
  const dir = join(BRIDGE_OUT_BASE, `${kind}-${String(chatId)}${runId ? `-${runId}` : ""}`);
  // Wipe any files left by a previous partial run before handing the dir to the CLI.
  clearRetentionTimer(dir);
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
  clearRetentionTimer(outDir);
  await rm(outDir, { recursive: true, force: true });
}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

async function notifyPartialDelivery(
  client: Pick<MessagingPlatform, "sendPhoto" | "sendDocument"> & Partial<Pick<MessagingPlatform, "sendMessage">>,
  chatId: number | string,
  failedCount: number,
  retainedUntil: string | null,
  options: FileSendOptions | undefined,
  canPublish: () => boolean,
): Promise<void> {
  if (typeof client.sendMessage !== "function" || !canPublish()) return;
  const noun = failedCount === 1 ? "file" : "files";
  const pronoun = failedCount === 1 ? "It" : "They";
  const retention = retainedUntil
    ? `${pronoun} ${failedCount === 1 ? "has" : "have"} been retained for recovery until ${retainedUntil}.`
    : `${pronoun} could not be retained safely.`;
  try {
    await client.sendMessage({
      chat_id: chatId,
      ...(options ?? {}),
      text: `⚠️ ${failedCount} generated ${noun} could not be delivered. ${retention}`,
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
  const existingRetention = await readRetentionMarker(outDir);
  if (existingRetention.state === "valid") clearRetentionTimer(outDir);
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
    const failedFiles = failedPaths.map((filePath) => basename(filePath));
    if (existingRetention.state === "invalid" || existingRetention.state === "unavailable") {
      await cleanOutputDir(outDir);
      await notifyPartialDelivery(client, chatId, failedPaths.length, null, options, canPublish);
      return { status: "partial", uploadedFiles, failedFiles, retainedUntil: null };
    }

    let retainedUntil: string;
    let retainedUntilMs: number;
    if (existingRetention.state === "valid") {
      if (existingRetention.expiresAtMs <= Date.now()) {
        await cleanOutputDir(outDir);
        await notifyPartialDelivery(client, chatId, failedPaths.length, null, options, canPublish);
        return { status: "partial", uploadedFiles, failedFiles, retainedUntil: null };
      }
      retainedUntil = existingRetention.expiresAt;
      retainedUntilMs = existingRetention.expiresAtMs;
    } else {
      retainedUntilMs = Date.now() + FAILED_OUTPUT_RETENTION_MS;
      retainedUntil = new Date(retainedUntilMs).toISOString();
      try {
        await writeFile(join(outDir, RETENTION_MARKER), `${JSON.stringify({ expiresAt: retainedUntil })}\n`, { mode: 0o600 });
      } catch (error) {
        console.error("[fileOutput] failed to persist bounded output retention:", error);
        await cleanOutputDir(outDir);
        await notifyPartialDelivery(client, chatId, failedPaths.length, null, options, canPublish);
        return { status: "partial", uploadedFiles, failedFiles, retainedUntil: null };
      }
    }
    if (!canPublish()) {
      await cleanOutputDir(outDir);
      return { status: "cancelled", uploadedFiles, failedFiles: [], retainedUntil: null };
    }
    scheduleRetainedOutputCleanup(outDir, retainedUntilMs);
    await notifyPartialDelivery(client, chatId, failedPaths.length, retainedUntil, options, canPublish);
    return {
      status: "partial",
      uploadedFiles,
      failedFiles,
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
