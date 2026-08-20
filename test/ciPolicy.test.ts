import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

describe("CI full-suite ownership policy", () => {
  it("cancels only superseded pull-request CI and architecture runs", () => {
    const ci = readRepoFile(".github/workflows/ci.yml");
    const architectureLint = readRepoFile(".github/workflows/architecture-lint.yml");

    expect(ci).toContain("group: ci-${{ github.event.pull_request.number || github.run_id }}");
    expect(architectureLint).toContain("group: architecture-lint-${{ github.event.pull_request.number || github.run_id }}");

    for (const workflow of [ci, architectureLint]) {
      expect(workflow).toContain("concurrency:");
      expect(workflow).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
    }
  });

  it("runs the authoritative full suite on the release Node version", () => {
    const ci = readRepoFile(".github/workflows/ci.yml");
    const releaseArtifact = readRepoFile(".github/workflows/release-artifact.yml");
    const packageJson = JSON.parse(readRepoFile("package.json")) as { engines?: { node?: string } };

    expect(packageJson.engines?.node).toBe(">=24");
    expect(ci).toContain("node-version: 24.15.0");
    expect(releaseArtifact).toContain("node-version: 24.15.0");
  });

  it("runs the authoritative CI suite once and keeps release-artifact tests off pull requests", () => {
    const ci = readRepoFile(".github/workflows/ci.yml");
    const releaseArtifact = readRepoFile(".github/workflows/release-artifact.yml");

    expect(ci).toContain("- run: npm test");
    expect(releaseArtifact).toContain("if: github.event_name != 'pull_request'");
    expect(releaseArtifact).toContain("run: npm test");
    expect(releaseArtifact).toContain("run: npm run typecheck");
    expect(releaseArtifact).toContain("run: bash scripts/arch-lint.sh src");
  });

  it("qualifies test-runtime changes with bounded parallel resource stress", () => {
    const ci = readRepoFile(".github/workflows/ci.yml");
    const stress = readRepoFile(".github/workflows/resource-stress.yml");
    const vitest = readRepoFile("vitest.config.ts");
    const packageJson = JSON.parse(readRepoFile("package.json")) as { scripts?: Record<string, string> };

    const workerMatch = vitest.match(/maxWorkers:\s*(\d+)/);
    expect(workerMatch).not.toBeNull();
    const maxWorkers = Number(workerMatch?.[1]);
    expect(maxWorkers).toBeGreaterThan(1);
    expect(maxWorkers).toBeLessThanOrEqual(4);

    for (const workflow of [ci, stress]) {
      const heapMatch = workflow.match(/--max-old-space-size=(\d+)/);
      expect(heapMatch).not.toBeNull();
      expect(Number(heapMatch?.[1])).toBeGreaterThan(0);
      expect(Number(heapMatch?.[1])).toBeLessThanOrEqual(4096);
    }

    expect(packageJson.scripts?.["test:resources"]).toContain("--detect-async-leaks");
    expect(stress).toContain("pull_request:");
    expect(stress).toContain("vitest.config.ts");
    expect(stress).toContain(".github/workflows/ci.yml");
    expect(stress).toContain("package.json");
    expect(stress.match(/\/usr\/bin\/time -v npm /g)).toHaveLength(2);
    expect(stress).toContain("/usr/bin/time -v npm test");
    expect(stress).toContain("/usr/bin/time -v npm run test:resources");
  });

  it("keeps release-artifact evidence truthful for PR versus release qualification", () => {
    const releaseArtifact = readRepoFile(".github/workflows/release-artifact.yml");

    expect(releaseArtifact).toContain("checks_json='[\"compile\",\"manifest\"]'");
    expect(releaseArtifact).toContain("checks_json='[\"test\",\"typecheck\",\"architecture-lint\",\"compile\",\"manifest\"]'");
    expect(releaseArtifact).toContain('"checks": ${checks_json}');
  });
});
