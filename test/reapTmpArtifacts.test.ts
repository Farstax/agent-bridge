import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
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
  function telemetryFixture(nodeStub: string) {
    const root = makeRoot();
    const release = join(root, "release");
    mkdirSync(join(release, "node_modules", "tsx", "dist"), { recursive: true });
    mkdirSync(join(release, "scripts"), { recursive: true });
    writeFileSync(join(release, "node_modules", "tsx", "dist", "cli.mjs"), "");
    writeFileSync(join(release, "scripts", "rollout-db.ts"), "");
    const current = join(root, "current");
    symlinkSync(release, current);
    const database = join(root, "interactive.db");
    writeFileSync(database, "");
    const nodeBin = join(root, "node-stub");
    writeFileSync(nodeBin, `#!/usr/bin/env bash\necho "$*" >> "${join(root, "calls")}"\n${nodeStub}\n`);
    chmodSync(nodeBin, 0o755);
    return {
      root,
      env: { REAP_TMP_ROOT: join(root, "tmp"), REAP_WORKTREE_REPOS: ",", BRIDGE_DB_PATH: database, BRIDGE_CURRENT_RELEASE_DIR: current, NODE_BIN: nodeBin },
    };
  }

  it("prunes ACP telemetry through the active release without a rollout", () => {
    const { root, env } = telemetryFixture("exit 0");
    const result = run(env);
    expect(result.status).toBe(0);
    expect(readFileSync(join(root, "calls"), "utf8")).toContain(`prune --db ${env.BRIDGE_DB_PATH}`);
  });

  it("defers ACP telemetry retention when the live database is locked", () => {
    const { env } = telemetryFixture('echo "SqliteError: database is locked (SQLITE_BUSY)" >&2; exit 1');
    const result = run(env);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("ACP telemetry retention deferred");
  });

  it("fails cleanup on a non-lock ACP telemetry retention error", () => {
    const { env } = telemetryFixture('echo "integrity check failed" >&2; exit 1');
    const result = run(env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("integrity check failed");
  });

  it("skips ACP telemetry retention when no database is configured", () => {
    const { root, env } = telemetryFixture("exit 0");
    const result = run({ ...env, BRIDGE_DB_PATH: "" });
    expect(result.status).toBe(0);
    expect(existsSync(join(root, "calls"))).toBe(false);
  });

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

  it("uses a bounded non-interactive admin fallback when ordinary removal is denied", () => {
    const tmpRoot = makeRoot();
    const staleScratch = join(tmpRoot, "agent-bridge-root-owned-rollout");
    const fakeBin = join(tmpRoot, "bin");
    mkdirSync(staleScratch, { recursive: true });
    mkdirSync(fakeBin, { recursive: true });
    ageEntry(staleScratch, 48);

    const fakeRm = join(fakeBin, "rm");
    writeFileSync(fakeRm, "#!/usr/bin/env bash\necho 'simulated permission denied' >&2\nexit 1\n");
    chmodSync(fakeRm, 0o755);
    const fakeSudo = join(fakeBin, "sudo");
    writeFileSync(fakeSudo, "#!/usr/bin/env bash\n[[ \"$1\" == \"-n\" ]] && shift\nexec \"$@\"\n");
    chmodSync(fakeSudo, 0o755);

    const result = run({
      REAP_TMP_ROOT: tmpRoot,
      REAP_MAX_AGE_HOURS: "24",
      PATH: `${fakeBin}:${process.env.PATH}`,
    });

    expect(result.status).toBe(0);
    expect(existsSync(staleScratch)).toBe(false);
    expect(result.stdout).toContain("administrative fallback");
    expect(result.stderr).not.toContain("simulated permission denied");
  });

  it("fails cleanup when ordinary and administrative removal both fail", () => {
    const tmpRoot = makeRoot();
    const staleScratch = join(tmpRoot, "agent-bridge-unremovable-rollout");
    const fakeBin = join(tmpRoot, "bin");
    mkdirSync(staleScratch, { recursive: true });
    mkdirSync(fakeBin, { recursive: true });
    ageEntry(staleScratch, 48);

    for (const name of ["rm", "sudo"]) {
      const executable = join(fakeBin, name);
      writeFileSync(executable, `#!/usr/bin/env bash\necho '${name} denied' >&2\nexit 1\n`);
      chmodSync(executable, 0o755);
    }

    const result = run({
      REAP_TMP_ROOT: tmpRoot,
      REAP_MAX_AGE_HOURS: "24",
      PATH: `${fakeBin}:${process.env.PATH}`,
    });

    expect(result.status).toBe(1);
    expect(existsSync(staleScratch)).toBe(true);
    expect(result.stderr).toContain("cleanup incomplete");
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

  function makeDetachedCheckout(root: string): { checkout: string; dependencies: string } {
    const checkout = join(root, "agent-bridge-detached");
    initGitRepo(checkout);
    writeFileSync(join(checkout, ".gitignore"), "node_modules/\n");
    execFileSync("git", ["-C", checkout, "add", ".gitignore"]);
    execFileSync("git", ["-C", checkout, "commit", "-q", "-m", "ignore reproducible dependencies"]);
    execFileSync("git", ["-C", checkout, "remote", "add", "origin", "https://github.com/Farstax/agent-bridge.git"]);
    execFileSync("git", ["-C", checkout, "update-ref", "refs/remotes/origin/main", "HEAD"]);
    execFileSync("git", ["-C", checkout, "checkout", "-q", "--detach", "HEAD"]);
    const dependencies = join(checkout, "node_modules");
    mkdirSync(dependencies);
    writeFileSync(join(dependencies, "reconstructible-module"), "cached package\n");
    ageEntry(join(dependencies, "reconstructible-module"), 48);
    ageEntry(dependencies, 48);
    return { checkout, dependencies };
  }

  it("reclaims reproducible dependencies in an explicitly verified inactive detached OSS checkout", () => {
    const root = makeRoot();
    const { checkout, dependencies } = makeDetachedCheckout(root);
    const result = run({
      REAP_TMP_ROOT: join(root, "tmp"),
      REAP_WORKTREE_REPOS: ",",
      REAP_DETACHED_CHECKOUTS: checkout,
      REAP_OSS_ORIGIN: "https://github.com/Farstax/agent-bridge.git",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(dependencies)).toBe(false);
    expect(existsSync(join(checkout, ".git"))).toBe(true);
    expect(result.stdout).toContain("inactive clean detached OSS dependencies");
    const second = run({ REAP_TMP_ROOT: join(root, "tmp"), REAP_WORKTREE_REPOS: ",", REAP_DETACHED_CHECKOUTS: checkout });
    expect(second.status).toBe(0);
  });

  it("preserves detached dependencies when the checkout is dirty, unverified or active", () => {
    const root = makeRoot();
    const { checkout, dependencies } = makeDetachedCheckout(root);
    const env = { REAP_TMP_ROOT: join(root, "tmp"), REAP_WORKTREE_REPOS: ",", REAP_DETACHED_CHECKOUTS: checkout, REAP_OSS_ORIGIN: "https://github.com/Farstax/agent-bridge.git" };
    writeFileSync(join(checkout, "unique-untracked-work"), "do not delete");
    expect(run(env).status).toBe(0);
    expect(existsSync(dependencies)).toBe(true);
    rmSync(join(checkout, "unique-untracked-work"));
    execFileSync("git", ["-C", checkout, "remote", "set-url", "origin", "https://github.com/other/repo.git"]);
    expect(run(env).status).toBe(0);
    expect(existsSync(dependencies)).toBe(true);
    execFileSync("git", ["-C", checkout, "remote", "set-url", "origin", "https://github.com/Farstax/agent-bridge.git"]);
    writeFileSync(join(dependencies, ".pid"), String(process.pid));
    expect(run(env).status).toBe(0);
    expect(existsSync(dependencies)).toBe(true);
    rmSync(join(dependencies, ".pid"));
    execFileSync("git", ["-C", checkout, "update-ref", "-d", "refs/remotes/origin/main"]);
    expect(run(env).status).toBe(0);
    expect(existsSync(dependencies)).toBe(true);
  });

  it("keeps active branch checkouts and fresh dependencies", () => {
    const root = makeRoot();
    const { checkout, dependencies } = makeDetachedCheckout(root);
    const env = { REAP_TMP_ROOT: join(root, "tmp"), REAP_WORKTREE_REPOS: ",", REAP_DETACHED_CHECKOUTS: checkout, REAP_OSS_ORIGIN: "https://github.com/Farstax/agent-bridge.git" };
    execFileSync("git", ["-C", checkout, "switch", "-q", "-c", "active-work"]);
    expect(run(env).status).toBe(0);
    expect(existsSync(dependencies)).toBe(true);
    execFileSync("git", ["-C", checkout, "checkout", "-q", "--detach", "HEAD"]);
    ageEntry(dependencies, 0);
    expect(run(env).status).toBe(0);
    expect(existsSync(dependencies)).toBe(true);
  });


  it("reports measured free bytes, inodes and the remaining operator-supplied admission shortfall", () => {
    const root = makeRoot();
    const result = run({
      REAP_TMP_ROOT: root,
      REAP_REPORT_ROOT: root,
      REAP_WORKTREE_REPOS: ",",
      REAP_REQUIRED_HEADROOM_BYTES: "999999999999999",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/disk_headroom root=.*free_bytes=[0-9]+ observed_recovered_bytes=[0-9]+ free_inodes=[0-9]+/);
    expect(result.stdout).toMatch(/disk_admission required_bytes=999999999999999 shortfall_bytes=[1-9][0-9]*/);
  });


  it("preserves a stale dependency root when a nested module was recently written", () => {
    const root = makeRoot();
    const { checkout, dependencies } = makeDetachedCheckout(root);
    writeFileSync(join(dependencies, "recently-installed"), "new package");
    ageEntry(dependencies, 48);
    const result = run({
      REAP_TMP_ROOT: join(root, "tmp"),
      REAP_WORKTREE_REPOS: ",",
      REAP_DETACHED_CHECKOUTS: checkout,
      REAP_OSS_ORIGIN: "https://github.com/Farstax/agent-bridge.git",
    });
    expect(result.status).toBe(0);
    expect(existsSync(dependencies)).toBe(true);
    expect(result.stdout).toContain("recent dependency writes");
  });


  it("preserves dependencies while a live same-user process has the checkout as its cwd", async () => {
    const root = makeRoot();
    const { checkout, dependencies } = makeDetachedCheckout(root);
    const child = spawn("sleep", ["20"], { cwd: checkout, stdio: "ignore" });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", () => resolve());
        child.once("error", reject);
      });
      const result = run({
        REAP_TMP_ROOT: join(root, "tmp"),
        REAP_WORKTREE_REPOS: ",",
        REAP_DETACHED_CHECKOUTS: checkout,
      REAP_OSS_ORIGIN: "https://github.com/Farstax/agent-bridge.git",
      });
      expect(result.status).toBe(0);
      expect(existsSync(dependencies)).toBe(true);
      expect(result.stdout).toContain("active checkout");
    } finally {
      child.kill();
    }
  });

});
