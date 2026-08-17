import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

const removedPaths = [
  ".env.worker.example",
  "SOUL.md",
  "src/dummyUtil.ts",
  "test/dummyUtil.test.ts",
  "scripts/native-layout-spike.ts",
  "test/nativeLayoutSpike.test.ts",
  "docs/native-telegram-layout-spike.md",
  "scripts/telegraph-spike.ts",
  "test/telegraphSpike.test.ts",
  "docs/telegraph-instant-view-research.md",
  "scripts/test-agy-spike.ts",
  "scripts/research/issue-347-memory-benchmark.mjs",
  "docs/research/issue-347-runtime-simplification.md",
  "docs/DOCUMENTATION-AUDIT.md",
  "tsconfig.unused.json",
  "tests/ciPolicy.test.ts",
] as const;

describe("obsolete repository residue boundary", () => {
  it.each(removedPaths)("keeps %s out of the active repository", (path) => {
    expect(existsSync(resolve(root, path))).toBe(false);
  });

  it("keeps the canonical CI policy test under test/", () => {
    expect(existsSync(resolve(root, "test/ciPolicy.test.ts"))).toBe(true);
  });

  it("keeps provider instruction files as deltas over AGENTS.md", () => {
    for (const path of ["CLAUDE.md", "ANTIGRAVITY.md"]) {
      const content = readFileSync(resolve(root, path), "utf8");
      expect(content).toContain("AGENTS.md");
      expect(content).not.toMatch(/Engineering Worker|worker-only|worker drain/i);
      expect(content.length).toBeLessThan(2500);
    }
  });
});
