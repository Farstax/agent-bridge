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
  "docs/autonomous-agent-bridge-research.md",
  "docs/agent-driven-memory-research.md",
  "docs/antigravity-agent-view-spike.md",
  "docs/claude-agent-view-spike.md",
  "docs/cursor-agent-spike-research.md",
  "docs/cursor-sdk-spike-research.md",
  "docs/execution-lane-rollout.md",
  "docs/health-monitor-rectification.md",
  "docs/oss-product-split-plan.md",
  "docs/research/issue-388-provider-stream-contract.md",
  "docs/spike-file-exchange-telegram.md",
  "docs/token-optimization-research.md",
  "docs/xurl-spike.md",
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

  it("removes current Worker runtime guidance from AGENTS.md", () => {
    const agents = readFileSync(resolve(root, "AGENTS.md"), "utf8");

    expect(agents).not.toContain("# Autonomous Worker Loop — invariants");
    expect(agents).not.toMatch(/worker deploys|worker-specific drain flow/i);
    expect(agents).not.toMatch(/Worker jobs choose effort/i);
  });
});
