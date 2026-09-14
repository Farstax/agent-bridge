import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const CACHE_MANIFEST_VERSION = 1;
const BUILD_SIGNATURE = "rollout-db-bundle-v2\0--bundle\0--platform=node\0--format=esm\0--packages=external";

interface BundleCacheManifest {
  version: number;
  key: string;
  inputs: string[];
}

interface EsbuildMetafile {
  inputs?: Record<string, unknown>;
}

function defaultRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function safeInputPath(root: string, input: string): string {
  const absolute = resolve(root, input);
  const rel = relative(root, absolute);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`rollout-db bundle input escapes repository root: ${input}`);
  }
  return absolute;
}

function computeCacheKey(root: string, inputs: string[]): string {
  const hash = createHash("sha256");
  hash.update(BUILD_SIGNATURE);
  hash.update("\0esbuild\0");
  hash.update(readFileSync(join(root, "node_modules", "esbuild", "package.json")));
  for (const input of [...inputs].sort()) {
    hash.update("\0input\0");
    hash.update(input.replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(readFileSync(safeInputPath(root, input)));
  }
  return hash.digest("hex");
}

function readManifest(path: string): BundleCacheManifest | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<BundleCacheManifest>;
    if (parsed.version !== CACHE_MANIFEST_VERSION) return null;
    if (typeof parsed.key !== "string" || !/^[a-f0-9]{64}$/.test(parsed.key)) return null;
    if (!Array.isArray(parsed.inputs) || parsed.inputs.length === 0 || !parsed.inputs.every((input) => typeof input === "string")) return null;
    return { version: parsed.version, key: parsed.key, inputs: parsed.inputs };
  } catch {
    return null;
  }
}

function atomicWrite(path: string, content: string): void {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, content);
  try {
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

function validCachedBundle(root: string, cacheDir: string, manifestPath: string): string | null {
  const manifest = readManifest(manifestPath);
  if (!manifest) return null;
  try {
    const currentKey = computeCacheKey(root, manifest.inputs);
    if (currentKey !== manifest.key) return null;
    const outfile = join(cacheDir, `rollout-db-bundled-${currentKey}.mjs`);
    return existsSync(outfile) ? outfile : null;
  } catch {
    return null;
  }
}

export function getBundledRolloutDb(root = defaultRoot()): string {
  const cacheDir = join(root, "node_modules", ".cache", "agent-bridge");
  mkdirSync(cacheDir, { recursive: true });
  const manifestPath = join(cacheDir, "rollout-db-bundled-manifest.json");
  const cached = validCachedBundle(root, cacheDir, manifestPath);
  if (cached) return cached;

  const esbuildBin = join(root, "node_modules", ".bin", "esbuild");
  const entrypoint = "scripts/rollout-db.ts";
  const nonce = `${process.pid}-${randomUUID()}`;
  const tempBundle = join(cacheDir, `.rollout-db-bundled-${nonce}.mjs`);
  const tempMetafile = join(cacheDir, `.rollout-db-bundled-${nonce}.meta.json`);

  try {
    execFileSync(esbuildBin, [
      entrypoint,
      "--bundle",
      "--platform=node",
      "--format=esm",
      "--packages=external",
      `--outfile=${tempBundle}`,
      `--metafile=${tempMetafile}`,
    ], { cwd: root });

    const metafile = JSON.parse(readFileSync(tempMetafile, "utf8")) as EsbuildMetafile;
    const inputs = Object.keys(metafile.inputs ?? {}).sort();
    if (inputs.length === 0) throw new Error("esbuild did not report rollout-db bundle inputs");
    const key = computeCacheKey(root, inputs);
    const outfile = join(cacheDir, `rollout-db-bundled-${key}.mjs`);

    // A concurrent worker may already have published the same content-addressed
    // artifact. Otherwise publish the completed temp file atomically so no
    // caller can ever observe a partially written bundle.
    if (existsSync(outfile)) {
      rmSync(tempBundle, { force: true });
    } else {
      renameSync(tempBundle, outfile);
    }

    atomicWrite(manifestPath, `${JSON.stringify({ version: CACHE_MANIFEST_VERSION, key, inputs }, null, 2)}\n`);
    return outfile;
  } finally {
    rmSync(tempBundle, { force: true });
    rmSync(tempMetafile, { force: true });
  }
}
