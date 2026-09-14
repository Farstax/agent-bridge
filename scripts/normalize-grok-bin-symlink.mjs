#!/usr/bin/env node
/**
 * @xai-official/grok's postinstall can leave bin/grok as an absolute symlink
 * to grok-native. Release-artifact collection rejects links that escape the
 * archive root. Rewrite to a relative link when the package is present.
 *
 * Node's fs.cpSync({ dereference: true }) can also rewrite that relative link
 * into an absolute symlink back at the source tree. The same rewrite must
 * therefore run against copied artifact roots, not only the checkout.
 */
import { existsSync, lstatSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function normalizeGrokBinSymlink(root) {
  const binDir = join(root, "node_modules", "@xai-official", "grok", "bin");
  const link = join(binDir, "grok");
  const native = join(binDir, "grok-native");
  if (!existsSync(native)) return;
  const relativeTarget = "./grok-native";
  try {
    const stat = lstatSync(link);
    if (stat.isSymbolicLink() && readlinkSync(link) === relativeTarget) return;
    if (!stat.isSymbolicLink()) return;
  } catch {
    // Missing or not a symlink — replace below.
  }
  try { unlinkSync(link); } catch { /* replace */ }
  symlinkSync(relativeTarget, link);
}

const root = process.argv[2]
  ? resolve(process.argv[2])
  : join(dirname(fileURLToPath(import.meta.url)), "..");
normalizeGrokBinSymlink(root);
