import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { cleanOutputDir, cleanupExpiredRetainedOutputDirs } from "../fileOutput.js";

// The existing private per-Run output directory is also the bounded Desk handoff.
// No public URLs, new service, or extra database are needed.
const ROOT = "/tmp/bridge-out";
const MANIFEST = ".desk-artifacts.json";
const RETENTION_MARKER = ".delivery-retained.json";
const RETAIN_MS = 24 * 60 * 60 * 1000;
const MAX_FILES = 8;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_CONVERSATION_RETAINED_BYTES = 64 * 1024 * 1024;

const MIME: Record<string, string> = {
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
  ".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown",
  ".markdown": "text/markdown", ".csv": "text/csv", ".json": "application/json",
  ".xml": "application/xml", ".yaml": "text/yaml", ".yml": "text/yaml",
  ".toml": "application/toml", ".log": "text/plain",
  ".js": "text/plain", ".jsx": "text/plain", ".ts": "text/plain",
  ".tsx": "text/plain", ".py": "text/plain", ".go": "text/plain",
  ".rs": "text/plain", ".java": "text/plain", ".c": "text/plain",
  ".h": "text/plain", ".cpp": "text/plain", ".sh": "text/plain",
  ".sql": "text/plain", ".html": "text/plain", ".css": "text/plain",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".doc": "application/msword", ".xls": "application/vnd.ms-excel",
  ".ppt": "application/vnd.ms-powerpoint",
};

export interface DeskArtifact {
  id: string;
  runId: string;
  turnIndex: number;
  name: string;
  mimeType: string;
  size: number;
  expiresAt: string;
}

type Manifest = {
  conversationId: string;
  runId: string;
  expiresAt: string;
  artifacts: DeskArtifact[];
};

function safeName(value: string): boolean {
  return value !== "." && value !== ".." && value === basename(value)
    && !/[\\/\x00-\x1f\x7f]/.test(value) && value.length <= 160;
}

async function readManifest(dir: string, conversationId: string): Promise<Manifest | null> {
  try {
    const value = JSON.parse(await readFile(join(dir, MANIFEST), "utf8")) as Manifest;
    if (value.conversationId !== conversationId || !Array.isArray(value.artifacts)
      || !Number.isFinite(Date.parse(value.expiresAt))) return null;
    return value;
  } catch { return null; }
}

/** Keep only explicitly supported regular files, with hard size/count bounds. */
export async function retainDeskArtifacts(
  outDir: string, conversationId: string, runId: string, turnIndex: number,
): Promise<{ retained: number; discarded: number }> {
  const entries = await readdir(outDir, { withFileTypes: true });
  const expiresAt = new Date(Date.now() + RETAIN_MS).toISOString();
  const artifacts: DeskArtifact[] = [];
  let total = 0;
  let discarded = 0;
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === MANIFEST || entry.name === RETENTION_MARKER) continue;
    const path = join(outDir, entry.name);
    const mimeType = MIME[extname(entry.name).toLowerCase()];
    if (!entry.isFile() || !safeName(entry.name) || !mimeType || artifacts.length >= MAX_FILES) {
      discarded += 1;
      await rm(path, { recursive: true, force: true });
      continue;
    }
    try {
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let size: number;
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_BYTES || total + stat.size > MAX_TOTAL_BYTES) {
          throw new Error("unsupported artifact size or type");
        }
        size = stat.size;
      } finally { await handle.close(); }
      total += size;
      artifacts.push({ id: randomUUID(), runId, turnIndex, name: entry.name, mimeType, size, expiresAt });
    } catch {
      discarded += 1;
      await unlink(path).catch(() => undefined);
    }
  }
  if (!artifacts.length) {
    await cleanOutputDir(outDir);
    return { retained: 0, discarded };
  }
  // A burst of small successful Runs must not grow private beta guest disks
  // indefinitely within the retention window. Preserve older links rather
  // than evicting still-valid artifacts to admit new output.
  const alreadyRetained = (await listDeskArtifacts(conversationId))
    .reduce((bytes, artifact) => bytes + artifact.size, 0);
  if (alreadyRetained + total > MAX_CONVERSATION_RETAINED_BYTES) {
    await cleanOutputDir(outDir);
    return { retained: 0, discarded: discarded + artifacts.length };
  }
  try {
    const manifest: Manifest = { conversationId, runId, expiresAt, artifacts };
    await writeFile(join(outDir, MANIFEST), JSON.stringify(manifest), { mode: 0o600, flag: "wx" });
    await writeFile(join(outDir, RETENTION_MARKER), JSON.stringify({ expiresAt }), { mode: 0o600, flag: "wx" });
    await cleanupExpiredRetainedOutputDirs();
    return { retained: artifacts.length, discarded };
  } catch (error) {
    await cleanOutputDir(outDir);
    throw error;
  }
}

async function manifests(conversationId: string): Promise<Array<{ dir: string; data: Manifest }>> {
  const results: Array<{ dir: string; data: Manifest }> = [];
  let dirs;
  try { dirs = await readdir(ROOT, { withFileTypes: true }); }
  catch { return results; }
  const marker = `-${conversationId}-`;
  for (const entry of dirs) {
    if (!entry.isDirectory() || !entry.name.includes(marker)) continue;
    const dir = join(ROOT, entry.name);
    const data = await readManifest(dir, conversationId);
    if (data && Date.parse(data.expiresAt) > Date.now()) results.push({ dir, data });
  }
  return results;
}

export async function listDeskArtifacts(conversationId: string): Promise<DeskArtifact[]> {
  const retained = await manifests(conversationId);
  return retained.flatMap(({ data }) => data.artifacts)
    .sort((a, b) => a.turnIndex - b.turnIndex || a.name.localeCompare(b.name));
}

/** Return only an opaque-ID-selected file owned by the server-resolved conversation. */
export async function readDeskArtifact(conversationId: string, id: string): Promise<
  | { status: "found"; artifact: DeskArtifact; base64: string }
  | { status: "not_found" | "expired" }
> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return { status: "not_found" };
  const entries = await manifests(conversationId);
  for (const { dir, data } of entries) {
    const artifact = data.artifacts.find((entry) => entry.id === id && safeName(entry.name));
    if (!artifact) continue;
    if (Date.parse(artifact.expiresAt) <= Date.now()) return { status: "expired" };
    const handle = await open(join(dir, artifact.name), constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
    if (!handle) return { status: "not_found" };
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== artifact.size || stat.size > MAX_BYTES) return { status: "not_found" };
      const bytes = await handle.readFile();
      return { status: "found", artifact, base64: bytes.toString("base64") };
    } finally { await handle.close(); }
  }
  return { status: "not_found" };
}

/** Reclaim staged output if durable Run settlement rejects/cancels it. */
export async function discardDeskRunArtifacts(conversationId: string, runId: string): Promise<void> {
  for (const { dir, data } of await manifests(conversationId)) {
    if (data.runId === runId) await cleanOutputDir(dir);
  }
}
