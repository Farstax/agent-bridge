import type { ContentBlock } from "@agentclientprotocol/sdk";
import { lstat, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

const MAX_FILES = 8;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const STALE_ATTACHMENT_AGE_MS = 24 * 60 * 60 * 1000;
const STAGING_PREFIX = ".agent-bridge-attachments-";
const OWNER_MARKER = ".agent-bridge-staging-owner";
const OWNER_MARKER_CONTENT = "agent-bridge-outward-attachment-v1\n";

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

function decodeBase64(value: string): Buffer {
  if (value.length > Math.ceil(MAX_FILE_BYTES / 3) * 4) throw new Error(`attachment size limit is ${MAX_FILE_BYTES} bytes per file`);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("attachment has invalid base64 data");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new Error("attachment has invalid base64 data");
  return bytes;
}

type Payload = { name: string; bytes: Buffer };

function payloadFor(block: ContentBlock, index: number): Payload {
  if (block.type === "image") {
    const mimeType = block.mimeType.toLowerCase();
    if (mimeType !== "image/png" && mimeType !== "image/jpeg") throw new Error(`unsupported attachment type: ${mimeType}`);
    return { name: safeName(block.uri ?? undefined, mimeType, index), bytes: decodeBase64(block.data) };
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
  if (textResource && Buffer.byteLength(resource.text, "utf8") > MAX_FILE_BYTES) {
    throw new Error(`attachment size limit is ${MAX_FILE_BYTES} bytes per file`);
  }
  const bytes = textResource ? Buffer.from(resource.text, "utf8") : decodeBase64(resource.blob);
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
  const payloads = attachments.map(payloadFor);
  let total = 0;
  for (const payload of payloads) {
    if (payload.bytes.byteLength > MAX_FILE_BYTES) throw new Error(`attachment size limit is ${MAX_FILE_BYTES} bytes per file`);
    total += payload.bytes.byteLength;
    if (total > MAX_TOTAL_BYTES) throw new Error(`attachment size limit is ${MAX_TOTAL_BYTES} bytes total`);
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

/** Remove only old, direct-child staging directories owned by this surface. */
export async function cleanupStaleOutwardAcpAttachments(workspaceRoot: string, now = Date.now()): Promise<number> {
  const root = await realpath(workspaceRoot);
  const cutoff = now - STALE_ATTACHMENT_AGE_MS;
  let removed = 0;
  for (const entry of await readdir(root)) {
    if (!entry.startsWith(STAGING_PREFIX)) continue;
    const path = join(root, entry);
    let info;
    try { info = await lstat(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!info.isDirectory() || (info.mode & 0o777) !== 0o700 || info.mtimeMs > cutoff) continue;
    const marker = join(path, OWNER_MARKER);
    let markerInfo;
    try { markerInfo = await lstat(marker); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!markerInfo.isFile() || (markerInfo.mode & 0o777) !== 0o600 ||
      (typeof process.getuid === "function" && (info.uid !== process.getuid() || markerInfo.uid !== process.getuid())) ||
      await readFile(marker, "utf8") !== OWNER_MARKER_CONTENT) continue;
    await rm(path, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}
