import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

describe("CI full-suite ownership policy", () => {
  it("cancels superseded pull-request CI and architecture runs", () => {
    const ci = readRepoFile(".github/workflows/ci.yml");
    const architectureLint = readRepoFile(".github/workflows/architecture-lint.yml");

    for (const workflow of [ci, architectureLint]) {
      expect(workflow).toContain("concurrency:");
      expect(workflow).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
    }
  });

  it("runs the full suite only once per pull-request head", () => {
    const ci = readRepoFile(".github/workflows/ci.yml");
    const releaseArtifact = readRepoFile(".github/workflows/release-artifact.yml");

    expect(ci).toContain("- run: npm test");
    expect(releaseArtifact).toContain("if: github.event_name != 'pull_request'");
    expect(releaseArtifact).toContain("run: npm test");
    expect(releaseArtifact).toContain("run: npm run typecheck");
    expect(releaseArtifact).toContain("run: bash scripts/arch-lint.sh src");
  });

  it("keeps release-artifact evidence truthful for PR versus release qualification", () => {
    const releaseArtifact = readRepoFile(".github/workflows/release-artifact.yml");

    expect(releaseArtifact).toContain("checks_json='[\"compile\",\"manifest\"]'");
    expect(releaseArtifact).toContain("checks_json='[\"test\",\"typecheck\",\"architecture-lint\",\"compile\",\"manifest\"]'");
    expect(releaseArtifact).toContain('"checks": ${checks_json}');
  });

  it("documents focused local TDD and exact-head CI as the full-suite merge gate", () => {
    const agents = readRepoFile("AGENTS.md");
    const claude = readRepoFile("CLAUDE.md");

    for (const guidance of [agents, claude]) {
      expect(guidance).toContain("focused red/green");
      expect(guidance).toContain("exact-head GitHub CI");
      expect(guidance).toContain("Do not rerun the full suite locally by default");
    }

    expect(agents).toContain("Independent review must not duplicate a current green full-suite run without a concrete investigation reason");
  });
});
