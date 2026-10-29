#!/usr/bin/env node
/**
 * Drop declaration files, source maps and the redundant Grok brotli payload
 * from an assembled production release root.
 *
 * Only regular files are unlinked. Symlinks are never followed, so a link
 * whose name ends in .map or .d.ts cannot delete its target.
 */
import { lstatSync, readdirSync, readlinkSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DECLARATION_SUFFIXES = [".d.ts", ".d.mts", ".d.cts"];

function isDeclaration(name) {
  return DECLARATION_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

function walkFiles(directory, visit) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, visit);
      continue;
    }
    if (entry.isFile()) visit(full, entry.name);
  }
}

function grokNativeReady(root) {
  const nativePath = path.join(root, "node_modules/@xai-official/grok/bin/grok-native");
  const linkPath = path.join(root, "node_modules/@xai-official/grok/bin/grok");
  try {
    const nativeStat = lstatSync(nativePath);
    if (!nativeStat.isFile()) return false;
    const linkStat = lstatSync(linkPath);
    if (!linkStat.isSymbolicLink()) return false;
    const target = readlinkSync(linkPath);
    return target === "grok-native" || target.endsWith("/grok-native");
  } catch {
    return false;
  }
}

function isRedundantGrokPayload(root, full, name) {
  if (!name.endsWith(".br")) return false;
  const platformRoot = path.join(root, "node_modules/@xai-official");
  const relative = path.relative(platformRoot, full);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
  return /^grok-linux-[^/]+\/bin\/[^/]+\.br$/.test(relative);
}

export function pruneProductionPayload(root) {
  const removeGrokPayload = grokNativeReady(root);
  let removedCount = 0;
  let removedBytes = 0;
  walkFiles(root, (full, name) => {
    const declarationOrMap = name.endsWith(".map") || isDeclaration(name);
    const grokPayload = removeGrokPayload && isRedundantGrokPayload(root, full, name);
    if (!declarationOrMap && !grokPayload) return;
    const stat = lstatSync(full);
    if (!stat.isFile()) return;
    unlinkSync(full);
    removedCount += 1;
    removedBytes += stat.size;
  });
  return { removed_count: removedCount, removed_bytes: removedBytes };
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === fileURLToPath(import.meta.url);
}

if (invokedDirectly()) {
  const rootFlag = process.argv.indexOf("--root");
  const root = rootFlag >= 0 ? process.argv[rootFlag + 1] : "";
  if (!root) {
    process.stderr.write("usage: prune-production-payload.mjs --root <release-root>\n");
    process.exit(2);
  }
  const result = pruneProductionPayload(path.resolve(root));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
