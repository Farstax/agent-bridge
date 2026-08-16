import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const cleanup: string[] = [];
const generator = fileURLToPath(new URL("../scripts/generate-release-notes.sh", import.meta.url));

function git(repo: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: repo, stdio: "pipe" });
}

function commit(repo: string, file: string, message: string): string {
  writeFileSync(join(repo, file), `${message}\n`);
  git(repo, "add", file);
  git(repo, "commit", "--no-gpg-sign", "-m", message);
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
}

function buildRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "agent-bridge-release-notes-"));
  cleanup.push(repo);
  git(repo, "init", "--quiet", "--initial-branch=main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  return repo;
}

function runGenerator(repo: string, args: string[]) {
  return spawnSync("bash", [generator, ...args], { cwd: repo, encoding: "utf8" });
}

afterEach(() => {
  while (cleanup.length > 0) rmSync(cleanup.pop()!, { recursive: true, force: true });
});

describe("release notes generator", () => {
  it("includes commit, workflow run and checksum identity", () => {
    const repo = buildRepo();
    commit(repo, "a.txt", "chore: seed");
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

    const result = runGenerator(repo, [
      "--commit",
      head,
      "--workflow-run",
      "123456789",
      "--checksum",
      "a".repeat(64),
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`\`${head}\``);
    expect(result.stdout).toContain("`123456789`");
    expect(result.stdout).toContain(`\`${"a".repeat(64)}\``);
  });

  it("lists merged pull requests since the previous release tag", () => {
    const repo = buildRepo();
    commit(repo, "a.txt", "chore: seed");
    git(repo, "tag", "release-2026.08.01-1");

    git(repo, "checkout", "--quiet", "-b", "feature/one");
    commit(repo, "b.txt", "feat: add widget");
    git(repo, "checkout", "--quiet", "main");
    git(repo, "merge", "--no-ff", "--no-gpg-sign", "-m", "Merge pull request #101 from org/feature-one\n\nAdd widget support", "feature/one");

    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

    const result = runGenerator(repo, [
      "--commit",
      head,
      "--workflow-run",
      "1",
      "--checksum",
      "b".repeat(64),
      "--previous-tag",
      "release-2026.08.01-1",
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Changes since `release-2026.08.01-1`");
    expect(result.stdout).toContain("#101");
    expect(result.stdout).toContain("Add widget support");
  });

  it("lists squash-merged pull requests, which land as single-parent commits", () => {
    const repo = buildRepo();
    commit(repo, "a.txt", "chore: seed");
    git(repo, "tag", "release-2026.08.01-1");

    commit(repo, "b.txt", "Add gadget support (#202)");

    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    const parentCount = execFileSync("git", ["rev-list", "--count", "--merges", `${head}~1..${head}`], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    expect(parentCount).toBe("0");

    const result = runGenerator(repo, [
      "--commit",
      head,
      "--workflow-run",
      "1",
      "--checksum",
      "d".repeat(64),
      "--previous-tag",
      "release-2026.08.01-1",
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("#202");
    expect(result.stdout).toContain("Add gadget support");
  });

  it("does not list a branch's internal commits as separate pull requests", () => {
    const repo = buildRepo();
    commit(repo, "a.txt", "chore: seed");
    git(repo, "tag", "release-2026.08.01-1");

    git(repo, "checkout", "--quiet", "-b", "feature/two");
    commit(repo, "b.txt", "test: red — widget support (#303)");
    commit(repo, "c.txt", "feat: widget support (#303)");
    git(repo, "checkout", "--quiet", "main");
    git(repo, "merge", "--no-ff", "--no-gpg-sign", "-m", "Merge pull request #303 from org/feature-two\n\nWidget support", "feature/two");

    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

    const result = runGenerator(repo, [
      "--commit",
      head,
      "--workflow-run",
      "1",
      "--checksum",
      "e".repeat(64),
      "--previous-tag",
      "release-2026.08.01-1",
    ]);

    expect(result.status, result.stderr).toBe(0);
    const occurrences = (result.stdout.match(/#303/g) ?? []).length;
    expect(occurrences).toBe(1);
  });

  it("states there is no prior release when no previous tag is given", () => {
    const repo = buildRepo();
    commit(repo, "a.txt", "chore: seed");
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

    const result = runGenerator(repo, [
      "--commit",
      head,
      "--workflow-run",
      "1",
      "--checksum",
      "c".repeat(64),
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Initial qualified release");
  });
});
