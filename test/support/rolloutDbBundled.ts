import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function getBundledRolloutDb(): string {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const cacheDir = join(root, "node_modules", ".cache", "agent-bridge");
  mkdirSync(cacheDir, { recursive: true });
  const outfile = join(cacheDir, "rollout-db-bundled.mjs");
  if (!existsSync(outfile)) {
    const esbuildBin = join(root, "node_modules", ".bin", "esbuild");
    const entrypoint = join(root, "scripts", "rollout-db.ts");
    execFileSync(esbuildBin, [
      entrypoint,
      "--bundle",
      "--platform=node",
      "--format=esm",
      "--packages=external",
      `--outfile=${outfile}`,
    ]);
  }
  return outfile;
}
