import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const FILES = [
  ".github/workflows/ci.yml",
  ".github/workflows/release-artifact.yml",
  ".github/workflows/resource-stress.yml",
  "package.json",
  "scripts/qualify-local.sh",
  "vitest.config.ts",
];

export function createCiFixture(repoRoot: string): { root: string; path: (relativePath: string) => string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "agent-bridge-ci-fixture-"));
  for (const relativePath of FILES) {
    const destination = join(root, relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(repoRoot, relativePath), destination);
  }

  return {
    root,
    path: (relativePath) => join(root, relativePath),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
