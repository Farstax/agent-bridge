import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const scriptPath = new URL("../scripts/reap-tmp-artifacts.sh", import.meta.url).pathname;

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "reap-test-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

function ageEntry(path: string, hoursOld: number) {
  const past = new Date(Date.now() - hoursOld * 3600_000);
  utimesSync(path, past, past);
}

function run(env: Record<string, string>, args: string[] = []) {
  return spawnSync("bash", [scriptPath, ...args], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

function initGitRepo(dir: string) {
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "Test"]);
  writeFileSync(join(dir, "README.md"), "root\n");
  execFileSync("git", ["-C", dir, "add", "README.md"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", "init"]);
}

describe("reap-tmp-artifacts.sh", () => {
  it("removes stale bridge-out run directories but keeps fresh ones", () => {
    const tmpRoot = makeRoot();
    const bridgeOut = join(tmpRoot, "bridge-out");
    const staleRun = join(bridgeOut, "claude-1-old");
    const freshRun = join(bridgeOut, "claude-1-fresh");
    mkdirSync(staleRun, { recursive: true });
    mkdirSync(freshRun, { recursive: true });
    ageEntry(staleRun, 48);

    const result = run({ REAP_TMP_ROOT: tmpRoot, REAP_MAX_AGE_HOURS: "24" });

    expect(result.status).toBe(0);
    expect(existsSync(staleRun)).toBe(false);
    expect(existsSync(freshRun)).toBe(true);
  });

  it("preserves an old artifact while a live PID ownership marker exists", () => {
    const tmpRoot = makeRoot();
    const activeRun = join(tmpRoot, "bridge-out", "claude-live-owned");
    mkdirSync(activeRun, { recursive: true });
    writeFileSync(join(activeRun, ".pid"), String(process.pid));
    ageEntry(activeRun, 48);

    const result = run({ REAP_TMP_ROOT: tmpRoot, REAP_MAX_AGE_HOURS: "24" });

    expect(result.status).toBe(0);
    expect(existsSync(activeRun)).toBe(true);
    expect(result.stdout).toContain("ownership signal");
  });

  it("removes stale bridge-uploads dirs, antigravity logs, and advisor sockets by age", () => {
    const tmpRoot = makeRoot();
    const staleUpload = join(tmpRoot, "bridge-uploads-claude-1-run1");
    const freshUpload = join(tmpRoot, "bridge-uploads-claude-1-run2");
    const staleLog = join(tmpRoot, "antigravity-abc.log");
    const staleSocket = join(tmpRoot, "agent-bridge-advisor-xyz.sock");
    mkdirSync(staleUpload, { recursive: true });
    mkdirSync(freshUpload, { recursive: true });
    writeFileSync(staleLog, "log");
    writeFileSync(staleSocket, "");
    ageEntry(staleUpload, 48);
    ageEntry(staleLog, 48);
    ageEntry(staleSocket, 48);

    const result = run({ REAP_TMP_ROOT: tmpRoot, REAP_MAX_AGE_HOURS: "24" });

    expect(result.status).toBe(0);
    expect(existsSync(staleUpload)).toBe(false);
    expect(existsSync(freshUpload)).toBe(true);
    expect(existsSync(staleLog)).toBe(false);
    expect(existsSync(staleSocket)).toBe(false);
  });

  it("age-sweeps plain agent-bridge-* scratch dirs but never touches ones containing a .git", () => {
    const tmpRoot = makeRoot();
    const staleScratch = join(tmpRoot, "agent-bridge-test-fixture-1");
    const gitClone = join(tmpRoot, "agent-bridge-pr-rebase-1");
    mkdirSync(staleScratch, { recursive: true });
    mkdirSync(gitClone, { recursive: true });
    mkdirSync(join(gitClone, ".git"), { recursive: true });
    ageEntry(staleScratch, 48);
    ageEntry(gitClone, 48);

    const result = run({ REAP_TMP_ROOT: tmpRoot, REAP_MAX_AGE_HOURS: "24" });

    expect(result.status).toBe(0);
    expect(existsSync(staleScratch)).toBe(false);
    expect(existsSync(gitClone)).toBe(true);
  });

  it("removes a worktree only when its branch is merged into main and it has no uncommitted changes", () => {
    const workRoot = makeRoot();
    const repo = join(workRoot, "repo");
    initGitRepo(repo);

    const mergedClean = join(workRoot, "wt-merged-clean");
    execFileSync("git", ["-C", repo, "worktree", "add", "-q", "-b", "feat/merged-clean", mergedClean]);
    execFileSync("git", ["-C", repo, "checkout", "-q", "main"]);
    execFileSync("git", ["-C", repo, "merge", "-q", "--no-ff", "feat/merged-clean", "-m", "merge"]);

    const mergedDirty = join(workRoot, "wt-merged-dirty");
    execFileSync("git", ["-C", repo, "worktree", "add", "-q", "-b", "feat/merged-dirty", mergedDirty]);
    execFileSync("git", ["-C", repo, "checkout", "-q", "main"]);
    execFileSync("git", ["-C", repo, "merge", "-q", "--no-ff", "feat/merged-dirty", "-m", "merge2"]);
    writeFileSync(join(mergedDirty, "scratch.txt"), "uncommitted");

    const unmergedClean = join(workRoot, "wt-unmerged-clean");
    execFileSync("git", ["-C", repo, "worktree", "add", "-q", "-b", "feat/unmerged-clean", unmergedClean]);
    writeFileSync(join(unmergedClean, "unmerged.txt"), "only on this branch\n");
    execFileSync("git", ["-C", unmergedClean, "add", "unmerged.txt"]);
    execFileSync("git", ["-C", unmergedClean, "commit", "-q", "-m", "unmerged work"]);

    const result = run({
      REAP_TMP_ROOT: join(workRoot, "no-tmp-here"),
      REAP_MAX_AGE_HOURS: "24",
      REAP_WORKTREE_REPOS: repo,
    });

    expect(result.status).toBe(0);
    expect(existsSync(mergedClean)).toBe(false);
    expect(existsSync(mergedDirty)).toBe(true);
    expect(existsSync(unmergedClean)).toBe(true);

    const branches = execFileSync("git", ["-C", repo, "branch", "--list"], { encoding: "utf8" });
    expect(branches).not.toContain("feat/merged-clean");
    expect(branches).toContain("feat/merged-dirty");
    expect(branches).toContain("feat/unmerged-clean");
  });

  it("dry-run reports actions without deleting anything", () => {
    const tmpRoot = makeRoot();
    const staleRun = join(tmpRoot, "bridge-out", "claude-1-old");
    mkdirSync(staleRun, { recursive: true });
    ageEntry(staleRun, 48);

    const result = run({ REAP_TMP_ROOT: tmpRoot, REAP_MAX_AGE_HOURS: "24" }, ["--dry-run"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("would remove");
    expect(existsSync(staleRun)).toBe(true);
  });
});
