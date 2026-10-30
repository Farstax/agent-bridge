import type { ContentBlock } from "@agentclientprotocol/sdk";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import { constants } from "node:fs";

const MAX_FILES = 8;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const STALE_ATTACHMENT_AGE_MS = 24 * 60 * 60 * 1000;
const STAGING_PREFIX = ".agent-bridge-attachments-";
const OWNER_MARKER = ".agent-bridge-staging-owner";
const OWNER_MARKER_CONTENT = "agent-bridge-outward-attachment-v1\n";

// A durable capacity-wait continuation lives up to MAX_CAPACITY_LIFETIME_MS
// (7 days, runContinuation.ts) past its creation. The retained-attachment
// sweep bound must exceed that so it only ever reclaims a directory whose
// continuation has definitely already settled or expired, never a live one.
const RETAINED_WAIT_PREFIX = ".agent-bridge-attachments-wait-";
const RETAINED_TMP_PREFIX = ".agent-bridge-attachments-wait-tmp-";
const RETAINED_WAIT_OWNER_MARKER_CONTENT = "agent-bridge-outward-attachment-wait-v1\n";
const STALE_RETAINED_WAIT_AGE_MS = 8 * 24 * 60 * 60 * 1000;

/** Deterministic, filesystem-safe directory name for one wait's retained attachments. */
function retainedWaitDirName(continuationId: string): string {
  return `${RETAINED_WAIT_PREFIX}${createHash("sha256").update(continuationId).digest("hex").slice(0, 32)}`;
}

const MIME_EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  "text/plain": [".txt", ".log", ".md", ".rst", ".py", ".js", ".jsx", ".ts", ".tsx", ".html", ".htm", ".css", ".sh", ".sql", ".xml", ".yaml", ".yml", ".toml", ".ini", ".conf", ".env", ".go", ".rs", ".java", ".c", ".h", ".cpp", ".hpp", ".rb", ".php", ".cs", ".kt", ".swift", ".vue", ".svelte", ".jsonc"],
  "text/markdown": [".md", ".markdown"],
  "text/html": [".html", ".htm"],
  "text/javascript": [".js", ".jsx", ".ts", ".tsx"],
  "application/javascript": [".js", ".jsx", ".ts", ".tsx"],
  "text/csv": [".csv"],
  "application/json": [".json"],
  "application/xml": [".xml"],
  "application/yaml": [".yaml", ".yml"],
  "application/toml": [".toml"],
  "application/pdf": [".pdf"],
  "image/png": [".png"],
  "image/jpeg": [".jpg", ".jpeg"],
};

const MIME_DEFAULT_EXT: Readonly<Record<string, string>> = {
  "text/plain": ".txt", "text/markdown": ".md", "text/csv": ".csv", "application/json": ".json",
  "text/html": ".html", "text/javascript": ".js", "application/javascript": ".js", "application/xml": ".xml",
  "application/yaml": ".yaml", "application/toml": ".toml", "application/pdf": ".pdf", "image/png": ".png", "image/jpeg": ".jpg",
};

const EXT_MIME = new Map(Object.entries(MIME_EXTENSIONS).flatMap(([mime, exts]) => exts.map((ext) => [ext, mime] as const)));

function safeName(uri: string | undefined, mimeType: string, index: number): string {
  let candidate = "";
  if (uri) {
    try { candidate = decodeURIComponent(basename(new URL(uri).pathname)); } catch { /* use the MIME-derived name */ }
  }
  candidate = candidate.replace(/[\/\\\0]/g, "_").replace(/[^A-Za-z0-9._ -]/g, "_").replace(/^\.+/, "").trim();
  const rawExt = extname(candidate).toLowerCase();
  const allowed = MIME_EXTENSIONS[mimeType] ?? [];
  const ext = allowed.includes(rawExt) ? rawExt : MIME_DEFAULT_EXT[mimeType];
  if (!ext) throw new Error(`unsupported attachment type: ${mimeType}`);
  const stem = (rawExt && allowed.includes(rawExt) ? candidate.slice(0, -rawExt.length) : candidate)
    .replace(/[^A-Za-z0-9._ -]/g, "_").replace(/^\.+/, "").trim().slice(0, 80);
  return `${String(index + 1).padStart(2, "0")}-${stem || "attachment"}${ext}`;
}

function decodeBase64(value: string, maxBytes = MAX_FILE_BYTES): Buffer {
  if (value.length > Math.ceil(MAX_FILE_BYTES / 3) * 4) throw new Error(`attachment size limit is ${MAX_FILE_BYTES} bytes per file`);
  if (value.length > Math.ceil(maxBytes / 3) * 4) throw new Error(`attachment size limit is ${MAX_TOTAL_BYTES} bytes total`);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("attachment has invalid base64 data");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new Error("attachment has invalid base64 data");
  if (bytes.byteLength > maxBytes) throw new Error(`attachment size limit is ${MAX_TOTAL_BYTES} bytes total`);
  return bytes;
}

type Payload = { name: string; bytes: Buffer };

function payloadFor(block: ContentBlock, index: number, remainingBytes: number): Payload {
  if (block.type === "image") {
    const mimeType = block.mimeType.toLowerCase();
    if (mimeType !== "image/png" && mimeType !== "image/jpeg") throw new Error(`unsupported attachment type: ${mimeType}`);
    return { name: safeName(block.uri ?? undefined, mimeType, index), bytes: decodeBase64(block.data, Math.min(MAX_FILE_BYTES, remainingBytes)) };
  }
  if (block.type !== "resource") throw new Error("unsupported ACP attachment block; embedded image or resource content is required");
  const resource = block.resource;
  const hintedMime = resource.mimeType?.toLowerCase() ?? "";
  const inferredMime = EXT_MIME.get(extname(resource.uri).toLowerCase());
  const mimeType = MIME_EXTENSIONS[hintedMime] ? hintedMime : inferredMime || "";
  if (!MIME_EXTENSIONS[mimeType]) throw new Error(`unsupported attachment type: ${mimeType || "unknown"}`);
  const textResource = "text" in resource;
  if (textResource && !mimeType.startsWith("text/") && mimeType !== "application/json" && mimeType !== "application/xml" && mimeType !== "application/yaml" && mimeType !== "application/toml") {
    throw new Error(`attachment type ${mimeType} requires binary content`);
  }
  const textBytes = textResource ? Buffer.byteLength(resource.text, "utf8") : 0;
  if (textResource && textBytes > MAX_FILE_BYTES) {
    throw new Error(`attachment size limit is ${MAX_FILE_BYTES} bytes per file`);
  }
  if (textResource && textBytes > remainingBytes) {
    throw new Error(`attachment size limit is ${MAX_TOTAL_BYTES} bytes total`);
  }
  const bytes = textResource
    ? Buffer.from(resource.text, "utf8")
    : decodeBase64(resource.blob, Math.min(MAX_FILE_BYTES, remainingBytes));
  return { name: safeName(resource.uri, mimeType, index), bytes };
}

/** Stage bounded embedded ACP files in a private task-owned directory and always remove it. */
export async function stageOutwardAcpAttachments<T>(
  cwd: string,
  blocks: readonly ContentBlock[],
  operation: (paths: string[]) => Promise<T>,
): Promise<T> {
  // resource_link is a metadata-only prompt block handled by promptText(); it
  // is never fetched or staged as a file. Only embedded payload blocks enter
  // this private workspace staging path.
  const attachments = blocks.filter((block) => block.type === "image" || block.type === "resource");
  if (attachments.length > MAX_FILES) throw new Error(`attachment file limit is ${MAX_FILES}`);
  const payloads: Payload[] = [];
  let total = 0;
  for (const [index, block] of attachments.entries()) {
    const payload = payloadFor(block, index, MAX_TOTAL_BYTES - total);
    if (payload.bytes.byteLength > MAX_FILE_BYTES) throw new Error(`attachment size limit is ${MAX_FILE_BYTES} bytes per file`);
    total += payload.bytes.byteLength;
    payloads.push(payload);
  }
  if (payloads.length === 0) return operation([]);

  const workspace = await realpath(cwd);
  if (!(await stat(workspace)).isDirectory()) throw new Error("attachment workspace is not a directory");
  const staging = await mkdtemp(join(workspace, STAGING_PREFIX));
  const paths: string[] = [];
  try {
    await writeFile(join(staging, OWNER_MARKER), OWNER_MARKER_CONTENT, { flag: "wx", mode: 0o600 });
    for (const payload of payloads) {
      const path = join(staging, payload.name);
      await writeFile(path, payload.bytes, { flag: "wx", mode: 0o600 });
      paths.push(path);
    }
    return await operation(paths);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/**
 * Copy already-staged attachment files into a durable, continuation-keyed
 * directory before stageOutwardAcpAttachments's own cleanup deletes the
 * ephemeral staging directory. Call this from inside the staging
 * `operation` callback, before it returns. Bounded by the same
 * MAX_FILES/MAX_TOTAL_BYTES already enforced at staging time.
 */
const RETAINED_MANIFEST = ".manifest.json";
type RetainedEntry = { name: string; size: number; sha256: string };

async function readPrivateFile(path: string, maximum: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maximum || (info.mode & 0o777) !== 0o600 ||
        (typeof process.getuid === "function" && info.uid !== process.getuid())) {
      throw new Error("invalid retained attachment file");
    }
    const bytes = await handle.readFile();
    if (bytes.length !== info.size || bytes.length > maximum) throw new Error("attachment changed during read");
    return bytes;
  } finally { await handle.close(); }
}

export async function retainOutwardAcpAttachmentsForWait(
  cwd: string,
  stagedPaths: readonly string[],
  continuationId: string,
): Promise<void> {
  if (stagedPaths.length > MAX_FILES) throw new Error("attachment file limit exceeded");
  const workspace = await realpath(cwd);
  const dir = join(workspace, retainedWaitDirName(continuationId));
  // Construct a complete, private snapshot before publishing the deterministic
  // continuation path. An interruption before rename leaves only an expirable
  // temporary directory; retry is never blocked by a half-written final path.
  const temporary = await mkdtemp(join(workspace, RETAINED_TMP_PREFIX));
  try {
    const entries: RetainedEntry[] = [];
    let total = 0;
    for (const path of stagedPaths) {
      const parent = await realpath(join(path, ".."));
      if (relative(workspace, parent).startsWith(`..${sep}`) || parent === workspace ||
          !basename(parent).startsWith(STAGING_PREFIX) || !(await verifiedOwnedDir(parent, OWNER_MARKER_CONTENT))) {
        throw new Error("attachment source is not owned staging");
      }
      const name = basename(path);
      if (name === OWNER_MARKER || name === RETAINED_MANIFEST || entries.some((entry) => entry.name === name)) {
        throw new Error("invalid attachment name");
      }
      const bytes = await readPrivateFile(path, MAX_FILE_BYTES);
      total += bytes.length;
      if (total > MAX_TOTAL_BYTES) throw new Error("attachment total size limit exceeded");
      await writeFile(join(temporary, name), bytes, { flag: "wx", mode: 0o600 });
      entries.push({ name, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    }
    await writeFile(join(temporary, RETAINED_MANIFEST), JSON.stringify({ continuationId, entries }), { flag: "wx", mode: 0o600 });
    await writeFile(join(temporary, OWNER_MARKER), RETAINED_WAIT_OWNER_MARKER_CONTENT, { flag: "wx", mode: 0o600 });
    // No-overwrite check: a concurrent completed retention or an attacker-
    // planted path must not be reused. The final directory is never empty.
    try {
      await lstat(dir);
      throw new Error("refusing to reuse an unverified path for retained attachments");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rename(temporary, dir);
  } finally {
    // No-op after successful rename. Also cleans partial temporary snapshots
    // after a failed write without deleting a previously published retention.
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function readRetainedOutwardAcpAttachments(cwd: string, continuationId: string): Promise<string[]> {
  const workspace = await realpath(cwd);
  const dir = join(workspace, retainedWaitDirName(continuationId));
  if (!(await verifiedOwnedDir(dir, RETAINED_WAIT_OWNER_MARKER_CONTENT))) throw new Error("retained attachments missing or unverified");
  const manifestBytes = await readPrivateFile(join(dir, RETAINED_MANIFEST), 16 * 1024);
  const manifest: unknown = JSON.parse(manifestBytes.toString("utf8"));
  if (!manifest || typeof manifest !== "object" || !("continuationId" in manifest) || manifest.continuationId !== continuationId ||
      !("entries" in manifest) || !Array.isArray(manifest.entries) || manifest.entries.length > MAX_FILES) {
    throw new Error("invalid retained attachment manifest");
  }
  const paths: string[] = [];
  let total = 0;
  const names = new Set<string>();
  for (const entry of manifest.entries) {
    if (!entry || typeof entry.name !== "string" || basename(entry.name) !== entry.name || entry.name.startsWith(".") ||
        names.has(entry.name) || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_FILE_BYTES ||
        typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error("invalid retained attachment entry");
    names.add(entry.name);
    total += entry.size;
    if (total > MAX_TOTAL_BYTES) throw new Error("attachment total size limit exceeded");
    const path = join(dir, entry.name);
    const bytes = await readPrivateFile(path, MAX_FILE_BYTES);
    if (bytes.length !== entry.size || createHash("sha256").update(bytes).digest("hex") !== entry.sha256) throw new Error("retained attachment integrity mismatch");
    paths.push(path);
  }
  const expected = new Set([OWNER_MARKER, RETAINED_MANIFEST, ...names]);
  if ((await readdir(dir)).some((name) => !expected.has(name))) throw new Error("unexpected retained attachment entry");
  return paths;
}

/** Idempotent cleanup on settlement (completed/cancelled/expired) or explicit release. */
export async function releaseRetainedOutwardAcpAttachments(cwd: string, continuationId: string): Promise<void> {
  const workspace = await realpath(cwd);
  const dir = join(workspace, retainedWaitDirName(continuationId));
  if (!(await verifiedOwnedDir(dir, RETAINED_WAIT_OWNER_MARKER_CONTENT))) return;
  await rm(dir, { recursive: true, force: true });
}

/** Confirms `dir` is a privately-owned directory this module created, by permission, uid and marker content. */
async function verifiedOwnedDir(dir: string, expectedMarkerContent: string): Promise<boolean> {
  let info;
  try { info = await lstat(dir); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (!info.isDirectory() || (info.mode & 0o777) !== 0o700) return false;
  const marker = join(dir, OWNER_MARKER);
  let markerInfo;
  try { markerInfo = await lstat(marker); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (!markerInfo.isFile() || (markerInfo.mode & 0o777) !== 0o600) return false;
  if (typeof process.getuid === "function" && (info.uid !== process.getuid() || markerInfo.uid !== process.getuid())) return false;
  return (await readFile(marker, "utf8")) === expectedMarkerContent;
}

/** Remove only old, owner-marked staging directories in known Workstream directories. */
export async function cleanupStaleOutwardAcpAttachments(
  workspaceRoot: string,
  additionalWorkspaces: readonly string[] = [],
  now = Date.now(),
): Promise<number> {
  const root = await realpath(workspaceRoot);
  const cutoff = now - STALE_ATTACHMENT_AGE_MS;
  let removed = 0;
  for (const candidate of new Set([root, ...additionalWorkspaces])) {
    let workspace: string;
    try { workspace = await realpath(candidate); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const workspaceRelative = relative(root, workspace);
    if (workspaceRelative === ".." || workspaceRelative.startsWith(`..${sep}`) || isAbsolute(workspaceRelative)) continue;
    if (!(await stat(workspace)).isDirectory()) continue;
    for (const entry of await readdir(workspace)) {
      // A retained-wait directory also matches STAGING_PREFIX (it extends
      // the same namespace) but must only ever be swept past its own much
      // longer, continuation-expiry-safe bound and marker (#1114).
      const isRetainedWait = entry.startsWith(RETAINED_WAIT_PREFIX);
      const isRetainedTemporary = entry.startsWith(RETAINED_TMP_PREFIX);
      if (!isRetainedWait && !entry.startsWith(STAGING_PREFIX)) continue;
      const path = join(workspace, entry);
      const entryCutoff = isRetainedWait ? now - STALE_RETAINED_WAIT_AGE_MS : cutoff;
      const expectedMarker = isRetainedWait ? RETAINED_WAIT_OWNER_MARKER_CONTENT : OWNER_MARKER_CONTENT;
      let info;
      try { info = await lstat(path); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (!info.isDirectory() || (info.mode & 0o777) !== 0o700 || info.mtimeMs > entryCutoff) continue;
      // The temporary snapshot may have been interrupted before its marker
      // was written. Private UID-owned, 0700, expired tmp directories are
      // safe to reclaim; never apply this exception to final retained paths.
      if (isRetainedTemporary) {
        if (typeof process.getuid === "function" && info.uid !== process.getuid()) continue;
        await rm(path, { recursive: true, force: true });
        removed += 1;
        continue;
      }
      const marker = join(path, OWNER_MARKER);
      let markerInfo;
      try { markerInfo = await lstat(marker); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (!markerInfo.isFile() || (markerInfo.mode & 0o777) !== 0o600 ||
        (typeof process.getuid === "function" && (info.uid !== process.getuid() || markerInfo.uid !== process.getuid())) ||
        await readFile(marker, "utf8") !== expectedMarker) continue;
      await rm(path, { recursive: true, force: true });
      removed += 1;
    }
  }
  return removed;
}
