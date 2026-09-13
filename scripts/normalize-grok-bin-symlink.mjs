#!/usr/bin/env node
/**
 * @xai-official/grok's postinstall can leave bin/grok as an absolute symlink
 * to grok-native. Release-artifact collection rejects links that escape the
 * archive root. Rewrite to a relative link when the package is present.
 */
import { existsSync, lstatSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const link = join(root, "node_modules", "@xai-official", "grok", "bin", "grok");
const target = join(root, "node_modules", "@xai-official", "grok", "bin", "grok-native");
if (!existsSync(link) && !existsSync(target)) process.exit(0);
if (!existsSync(target)) process.exit(0);
const relativeTarget = relative(dirname(link), target) || "./grok-native";
try {
  const stat = lstatSync(link);
  if (stat.isSymbolicLink() && readlinkSync(link) === relativeTarget) process.exit(0);
} catch {
  // Missing or not a symlink — replace below.
}
try { unlinkSync(link); } catch { /* replace */ }
symlinkSync(relativeTarget, link);
