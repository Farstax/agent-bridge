import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

describe("CI qualification ownership policy", () => {
  it("runs full PR qualification only for a non-draft merge candidate", () => {
    const ci = readRepoFile(".github/workflows/ci.yml");

    expect(ci).toContain("pull_request:");
    expect(ci).toContain("ready_for_review");
    expect(ci).toContain("converted_to_draft");
    expect(ci).toContain("github.event.pull_request.draft == false");
    expect(ci).toContain("group: ci-${{ github.event.pull_request.number || github.run_id }}");
    expect(ci).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
    expect(ci).not.toContain("branches: [main]");
  });

  it("runs the PR and release qualification on the release Node version", () => {
    const ci = readRepoFile(".github/workflows/ci.yml");
    const releaseArtifact = readRepoFile(".github/workflows/release-artifact.yml");
    const packageJson = JSON.parse(readRepoFile("package.json")) as { engines?: { node?: string } };

    expect(packageJson.engines?.node).toBe(">=24");
    expect(ci).toContain("node-version: 24.15.0");
    expect(releaseArtifact).toContain("node-version: 24.15.0");
  });

  it("has one owner for test, typecheck and architecture checks at each qualification boundary", () => {
    const ci = readRepoFile(".github/workflows/ci.yml");
    const releaseArtifact = readRepoFile(".github/workflows/release-artifact.yml");
    const qualifyLocal = readRepoFile("scripts/qualify-local.sh");

    // Both boundaries delegate to the same local script rather than each
    // duplicating the test/typecheck/arch-lint commands, so local and hosted
    // CI cannot drift apart.
    for (const workflow of [ci, releaseArtifact]) {
      expect(workflow).toContain("npm run qualify:local");
    }
    expect(qualifyLocal).toContain("npm test");
    expect(qualifyLocal).toContain("npm run typecheck");
    expect(qualifyLocal).toContain("bash scripts/arch-lint.sh src");

    expect(releaseArtifact).toContain("push:");
    expect(releaseArtifact).toContain("branches: [main]");
    expect(releaseArtifact).not.toContain("pull_request:");
  });

  it("qualifies test-runtime changes with bounded resource stress only when the PR is ready", () => {
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
    expect(stress).toContain("ready_for_review");
    expect(stress).toContain("converted_to_draft");
    expect(stress).toContain("github.event.pull_request.draft == false");
    expect(stress).toContain("vitest.config.ts");
    expect(stress).toContain(".github/workflows/ci.yml");
    expect(stress).toContain("package.json");
    expect(stress.match(/\/usr\/bin\/time -v npm /g)).toHaveLength(2);
  });

  it("keeps release-artifact evidence truthful for the qualified main state", () => {
    const releaseArtifact = readRepoFile(".github/workflows/release-artifact.yml");

    expect(releaseArtifact).toContain("checks_json='[\"test\",\"typecheck\",\"architecture-lint\",\"compile\",\"manifest\"]'");
    expect(releaseArtifact).toContain('"checks": ${checks_json}');
    expect(releaseArtifact).toContain("Upload qualified release artifact");
  });
});
