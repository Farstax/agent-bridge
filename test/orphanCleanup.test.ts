import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = new URL("..", import.meta.url).pathname;

function readSource(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

describe("startup orphan reconciliation", () => {
  it("uses guarded reconciliation in every interactive entrypoint", () => {
    const entrypoints = [
      "src/index.ts",
      "src/index-interactive.ts",
      "src/index-discord-interactive.ts",
      "src/index-health.ts",
      "src/index-worker.ts",
    ];

    for (const entrypoint of entrypoints) {
      const source = readSource(entrypoint);
      expect(source, `${entrypoint} should rely on service-scoped cleanup`).not.toContain("pkill");
      expect(source, `${entrypoint} should not kill CLI processes by global pattern`).not.toContain("killOrphanedCli");
      expect(source, `${entrypoint} should invoke guarded reconciliation`).toContain("reconcileOrphanedRuns");
      expect(source, `${entrypoint} should provide a process-liveness proof`).toContain("getExecutionProcessState");
    }
    const discord = readSource("src/index-discord-interactive.ts");
    expect(discord).toContain("reconciliationReady");
    expect(discord).toMatch(/reconciliationReady\s*\.then/);
  });
});
