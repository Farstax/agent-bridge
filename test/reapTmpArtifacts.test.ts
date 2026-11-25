import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { conversationDirectorySettingKey, ensureConversationDirectory } from "../src/conversationDirectory.js";
import { OutwardAcpSessionRepository } from "../src/repositories/outwardAcpSessionRepository.js";

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
    env: { ...process.env, HOME: "/nonexistent-home-for-reaper-tests", ...env },
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

  it("uses the stock interactive DB_PATH for ACP maintenance", () => {
    const { root, env } = telemetryFixture("exit 0");
    mkdirSync(join(root, "release", "src", "acpServer"), { recursive: true });
    writeFileSync(join(root, "release", "src", "acpServer", "maintenance.ts"), "");
    const { BRIDGE_DB_PATH: _bridgeDbPath, ...stockEnv } = env;
    const result = run({ ...stockEnv, DB_PATH: env.BRIDGE_DB_PATH, BRIDGE_ACP_WORKSPACE_ROOT: root });
    expect(result.status).toBe(0);
    expect(readFileSync(join(root, "calls"), "utf8")).toContain("src/acpServer/maintenance.ts");
  });

  it("runs ACP maintenance through the existing cleanup owner", () => {
    const { root, env } = telemetryFixture("exit 0");
    mkdirSync(join(root, "release", "src", "acpServer"), { recursive: true });
    writeFileSync(join(root, "release", "src", "acpServer", "maintenance.ts"), "");
    const result = run({ ...env, BRIDGE_ACP_WORKSPACE_ROOT: root });
    expect(result.status).toBe(0);
    expect(readFileSync(join(root, "calls"), "utf8")).toContain("src/acpServer/maintenance.ts");
  });

  it("prunes ACP telemetry through the active release without a rollout", () => {
    const { root, env } = telemetryFixture("exit 0");
    const result = run(env);
    expect(result.status).toBe(0);
    expect(readFileSync(join(root, "calls"), "utf8")).toContain(`prune --db ${env.BRIDGE_DB_PATH} --database-role ${env.BRIDGE_DB_PATH}=interactive`);
  });

  it("prefers the interactive runtime DB_PATH when a janitor-only override disagrees", () => {
    const { root, env } = telemetryFixture("exit 0");
    const conflicting = join(root, "wrong.db");
    writeFileSync(conflicting, "");
    const result = run({ ...env, DB_PATH: env.BRIDGE_DB_PATH, BRIDGE_DB_PATH: conflicting });
    expect(result.status).toBe(0);
    expect(readFileSync(join(root, "calls"), "utf8")).toContain(`prune --db ${env.BRIDGE_DB_PATH} --database-role ${env.BRIDGE_DB_PATH}=interactive`);
    expect(readFileSync(join(root, "calls"), "utf8")).not.toContain(conflicting);
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

  it("fails instead of silently skipping retention when an installed interactive database is required", () => {
    const { root, env } = telemetryFixture("exit 0");
    const result = run({ ...env, BRIDGE_DB_PATH: "", DB_PATH: "", REAP_REQUIRE_INTERACTIVE_DB: "1" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ACP telemetry retention failed: configured interactive database path is unset");
    expect(existsSync(join(root, "calls"))).toBe(false);
  });

  it("rejects an unsafe configured interactive database path rather than reporting retention success", () => {
    const { root, env } = telemetryFixture("exit 0");
    const result = run({ ...env, BRIDGE_DB_PATH: join(root, "missing.db"), REAP_REQUIRE_INTERACTIVE_DB: "1" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ACP telemetry retention failed: database path is unsafe");
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

  it("preserves merged worktrees when status fails, a lock is held, or a process is using the checkout", async () => {
    const root = makeRoot();
    const repo = join(root, "repo");
    initGitRepo(repo);
    const statusFailure = join(root, "status-failure");
    const locked = join(root, "locked");
    const active = join(root, "active");
    for (const [branch, path] of [["status-failure", statusFailure], ["locked", locked], ["active", active]]) {
      execFileSync("git", ["-C", repo, "worktree", "add", "-q", "-b", branch, path]);
    }
    execFileSync("git", ["-C", repo, "worktree", "lock", locked]);
    const bin = join(root, "bin");
    mkdirSync(bin);
    const fakeGit = join(bin, "git");
    writeFileSync(fakeGit, `#!/usr/bin/env bash
if [[ "$1" == "-C" && "$2" == "$REAP_TEST_BAD_WORKTREE" && "$3" == "status" ]]; then exit 2; fi
exec "$REAP_TEST_REAL_GIT" "$@"
`);
    chmodSync(fakeGit, 0o755);
    const child = spawn("sleep", ["20"], { cwd: active, stdio: "ignore" });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", () => resolve());
        child.once("error", reject);
      });
      const result = run({
        REAP_TMP_ROOT: join(root, "tmp"),
        REAP_WORKTREE_REPOS: repo,
        PATH: `${bin}:${process.env.PATH}`,
        REAP_TEST_BAD_WORKTREE: statusFailure,
        REAP_TEST_REAL_GIT: execFileSync("which", ["git"], { encoding: "utf8" }).trim(),
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("unverified worktree status");
      expect(result.stdout).toContain("active worktree");
      for (const path of [statusFailure, locked, active]) expect(existsSync(path)).toBe(true);
      const branches = execFileSync("git", ["-C", repo, "branch", "--list"], { encoding: "utf8" });
      for (const name of ["status-failure", "locked", "active"]) expect(branches).toContain(name);
    } finally {
      child.kill();
    }
  });

  it("preserves ignored files and branches not integrated into the remote default", () => {
    const root = makeRoot();
    const repo = join(root, "repo");
    initGitRepo(repo);
    execFileSync("git", ["-C", repo, "remote", "add", "origin", "https://example.invalid/repo.git"]);
    execFileSync("git", ["-C", repo, "update-ref", "refs/remotes/origin/main", "HEAD"]);
    const ignored = join(root, "ignored");
    const localOnly = join(root, "local-only");
    const safe = join(root, "safe");
    for (const [name, path] of [["ignored", ignored], ["local-only", localOnly], ["safe", safe]]) {
      execFileSync("git", ["-C", repo, "worktree", "add", "-q", "-b", name, path]);
    }
    writeFileSync(join(repo, ".git", "info", "exclude"), "private.txt\n");
    writeFileSync(join(ignored, "private.txt"), "preserve ignored data");
    writeFileSync(join(localOnly, "change.txt"), "not pushed");
    execFileSync("git", ["-C", localOnly, "add", "change.txt"]);
    execFileSync("git", ["-C", localOnly, "commit", "-q", "-m", "local only"]);
    execFileSync("git", ["-C", repo, "merge", "-q", "--ff-only", "local-only"]);
    const result = run({ REAP_TMP_ROOT: join(root, "tmp"), REAP_WORKTREE_REPOS: repo });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(safe)).toBe(false);
    expect(existsSync(localOnly)).toBe(true);
    expect(readFileSync(join(ignored, "private.txt"), "utf8")).toBe("preserve ignored data");
    const branches = execFileSync("git", ["-C", repo, "branch", "--list"], { encoding: "utf8" });
    expect(branches).toContain("ignored");
    expect(branches).toContain("local-only");
    expect(branches).not.toContain("safe");
  });

  it("preserves the primary checkout when inventory names a linked worktree", () => {
    const root = makeRoot();
    const repo = join(root, "repo");
    initGitRepo(repo);
    execFileSync("git", ["-C", repo, "switch", "-q", "-c", "primary-feature"]);
    const linked = join(root, "linked");
    execFileSync("git", ["-C", repo, "worktree", "add", "-q", linked, "main"]);
    const result = run({ REAP_TMP_ROOT: join(root, "tmp"), REAP_WORKTREE_REPOS: linked });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(repo, "README.md"))).toBe(true);
    expect(result.stdout).not.toContain("safe worktree removal refused");
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

  it("cleans only aged owned npm scratch and identifiable inactive browser downloads", () => {
    const root = makeRoot();
    const home = join(root, "home");
    const npmScratch = join(home, ".npm", "_cacache", "tmp");
    const oldBrowser = join(home, ".cache", "ms-playwright", "chromium-1234");
    const recentBrowser = join(home, ".cache", "ms-playwright", "chromium-5678");
    const unrelated = join(home, ".cache", "important-user-data");
    for (const dir of [npmScratch, oldBrowser, recentBrowser, unrelated]) mkdirSync(dir, { recursive: true });
    for (const dir of [npmScratch, oldBrowser]) {
      writeFileSync(join(dir, "rebuildable"), "cache");
      ageEntry(join(dir, "rebuildable"), 48);
      ageEntry(dir, 48);
    }
    writeFileSync(join(recentBrowser, "live"), "keep");
    const result = run({ HOME: home, REAP_TMP_ROOT: join(root, "empty-tmp"), REAP_WORKTREE_REPOS: "," });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(npmScratch)).toBe(false);
    expect(existsSync(oldBrowser)).toBe(false);
    expect(existsSync(recentBrowser)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
  }, 20_000);

  it("preserves an aged browser cache when a live process ownership signal exists", () => {
    const root = makeRoot();
    const home = join(root, "home");
    const browser = join(home, ".cache", "ms-playwright", "chromium-1234");
    mkdirSync(browser, { recursive: true });
    writeFileSync(join(browser, "rebuildable"), "cache");
    ageEntry(join(browser, "rebuildable"), 48);
    ageEntry(browser, 48);
    writeFileSync(join(browser, ".pid"), String(process.pid));
    const result = run({ HOME: home, REAP_TMP_ROOT: join(root, "empty-tmp"), REAP_WORKTREE_REPOS: "," });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(browser)).toBe(true);
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

  it("preserves tracked content in a detached node_modules directory", () => {
    const root = makeRoot();
    const { checkout, dependencies } = makeDetachedCheckout(root);
    const tracked = join(dependencies, "tracked");
    writeFileSync(tracked, "tracked content");
    execFileSync("git", ["-C", checkout, "add", "-f", "node_modules/tracked"]);
    execFileSync("git", ["-C", checkout, "commit", "-q", "-m", "track dependency content"]);
    execFileSync("git", ["-C", checkout, "update-ref", "refs/remotes/origin/main", "HEAD"]);
    ageEntry(tracked, 48);
    ageEntry(dependencies, 48);
    const result = run({
      REAP_TMP_ROOT: join(root, "tmp"),
      REAP_WORKTREE_REPOS: ",",
      REAP_DETACHED_CHECKOUTS: checkout,
      REAP_OSS_ORIGIN: "https://github.com/Farstax/agent-bridge.git",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("tracked dependencies");
    expect(readFileSync(tracked, "utf8")).toBe("tracked content");
  });

  it("preserves dependencies of a locked detached linked worktree", () => {
    const root = makeRoot();
    const { checkout: repo } = makeDetachedCheckout(root);
    const checkout = join(root, "locked-detached");
    execFileSync("git", ["-C", repo, "worktree", "add", "-q", "--detach", checkout, "HEAD"]);
    const dependencies = join(checkout, "node_modules");
    mkdirSync(dependencies);
    const module = join(dependencies, "rebuildable");
    writeFileSync(module, "cached");
    ageEntry(module, 48);
    ageEntry(dependencies, 48);
    execFileSync("git", ["-C", repo, "worktree", "lock", checkout]);
    const result = run({
      REAP_TMP_ROOT: join(root, "tmp"),
      REAP_WORKTREE_REPOS: repo,
      REAP_OSS_ORIGIN: "https://github.com/Farstax/agent-bridge.git",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(module)).toBe(true);
    const explicit = run({
      REAP_TMP_ROOT: join(root, "tmp"),
      REAP_WORKTREE_REPOS: ",",
      REAP_DETACHED_CHECKOUTS: checkout,
      REAP_OSS_ORIGIN: "https://github.com/Farstax/agent-bridge.git",
    });
    expect(explicit.status, explicit.stderr).toBe(0);
    expect(existsSync(module)).toBe(true);
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


  describe("against a real interactive database", { timeout: 60_000 }, () => {
    const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
    function realFixture() {
      const root = makeRoot();
      const current = join(root, "current");
      symlinkSync(repoRoot, current);
      const database = join(root, "interactive.db");
      openDb(database, { databaseRole: "interactive" }).close();
      const env = { REAP_TMP_ROOT: join(root, "tmp"), REAP_WORKTREE_REPOS: ",", BRIDGE_DB_PATH: database, BRIDGE_CURRENT_RELEASE_DIR: current, BRIDGE_ACP_WORKSPACE_ROOT: root, NODE_ENV: "test" };
      return { root, database, env };
    }

    function managedFixture() {
      const { root, database, env } = realFixture();
      const source = join(root, "source");
      initGitRepo(source);
      writeFileSync(join(source, ".gitignore"), "node_modules/\nprivate.txt\n");
      execFileSync("git", ["-C", source, "add", ".gitignore"]);
      execFileSync("git", ["-C", source, "commit", "-q", "-m", "ignore reproducible dependencies"]);
      // Real local upstream; no external network or mutable cached ref is proof.
      const origin = source;
      execFileSync("git", ["-C", source, "remote", "add", "origin", origin]);
      execFileSync("git", ["-C", source, "update-ref", "refs/remotes/origin/main", "HEAD"]);
      const identity = { surfaceIdentity: "acp:outward", chatKey: "acp:managed" };
      const directory = ensureConversationDirectory(source, identity);
      const db = openDb(database, { databaseRole: "interactive" });
      new OutwardAcpSessionRepository(db.raw).create({
        sessionId: "managed-session", conversationId: identity.chatKey, cwd: source, executionCwd: directory,
      });
      db.close();
      const addDependencies = (checkout: string) => {
        const dependencies = join(checkout, "node_modules");
        mkdirSync(dependencies);
        const file = join(dependencies, "cached");
        writeFileSync(file, "reproducible");
        ageEntry(file, 48);
        ageEntry(dependencies, 48);
        return dependencies;
      };
      const addWorktree = (branch: string) => {
        const checkout = join(directory, branch);
        execFileSync("git", ["-C", source, "worktree", "add", "-q", "-b", branch, checkout]);
        return checkout;
      };
      return { root, database, env: { ...env, BRIDGE_PROJECT_DIR: source }, identity, directory, source, origin, addDependencies, addWorktree };
    }

    it("discovers and removes a merged linked worktree and branch, reclaims standalone dependencies, preserves unrelated data", () => {
      const { root, env, directory, source, origin, addDependencies, addWorktree } = managedFixture();
      const merged = addWorktree("completed");
      addDependencies(merged);
      const detached = join(directory, "detached");
      execFileSync("git", ["clone", "-q", "--no-hardlinks", source, detached]);
      execFileSync("git", ["-C", detached, "remote", "set-url", "origin", origin]);
      execFileSync("git", ["-C", detached, "checkout", "-q", "--detach", "HEAD"]);
      const dependencies = addDependencies(detached);
      const ignored = addWorktree("private-data");
      writeFileSync(join(ignored, "private.txt"), "keep");
      const dirty = addWorktree("dirty");
      writeFileSync(join(dirty, "uncommitted.txt"), "keep");
      const unmerged = addWorktree("not-merged");
      writeFileSync(join(unmerged, "new.txt"), "new");
      execFileSync("git", ["-C", unmerged, "add", "new.txt"]);
      execFileSync("git", ["-C", unmerged, "commit", "-q", "-m", "not integrated"]);
      const outside = join(root, "outside");
      execFileSync("git", ["clone", "-q", "--no-hardlinks", source, outside]);
      const outsideDeps = addDependencies(outside);
      symlinkSync(outside, join(directory, "outside-link"));
      writeFileSync(join(directory, "conversation-note.txt"), "keep transcript-adjacent data");
      const dry = run(env, ["--dry-run"]);
      expect(dry.status, dry.stderr).toBe(0);
      expect(dry.stdout).toContain("would remove (inactive clean managed dependencies)");
      expect(dry.stdout).toContain("would remove worktree (merged+clean): " + merged);
      expect(existsSync(merged)).toBe(true);
      expect(existsSync(dependencies)).toBe(true);
      const result = run(env);
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(merged), result.stdout).toBe(false);
      expect(existsSync(dependencies), result.stdout).toBe(false);
      expect(existsSync(join(detached, ".git"))).toBe(true);
      expect(existsSync(join(ignored, "private.txt"))).toBe(true);
      expect(existsSync(join(dirty, "uncommitted.txt"))).toBe(true);
      expect(existsSync(join(unmerged, "new.txt"))).toBe(true);
      expect(existsSync(outsideDeps)).toBe(true);
      expect(readFileSync(join(directory, "conversation-note.txt"), "utf8")).toBe("keep transcript-adjacent data");
      const branches = execFileSync("git", ["-C", source, "branch", "--list"], { encoding: "utf8" });
      expect(branches).not.toContain("completed");
      expect(branches).toContain("private-data");
      expect(branches).toContain("not-merged");
      const second = run(env);
      expect(second.status, second.stderr).toBe(0);
      expect(existsSync(directory)).toBe(true);
    });

    it("preserves tracked changes hidden by assume-unchanged or skip-worktree", () => {
      const { env, source, addDependencies, addWorktree } = managedFixture();
      for (const flag of ["assume-unchanged", "skip-worktree"]) {
        const checkout = addWorktree(flag);
        execFileSync("git", ["-C", checkout, "update-index", "--" + flag, "README.md"]);
        writeFileSync(join(checkout, "README.md"), "uncommitted local change");
        expect(execFileSync("git", ["-C", checkout, "status", "--porcelain"], { encoding: "utf8" })).toBe("");
        addDependencies(checkout);
      }
      const result = run(env);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("hidden index entries");
      const branches = execFileSync("git", ["-C", source, "branch", "--list"], { encoding: "utf8" });
      for (const flag of ["assume-unchanged", "skip-worktree"]) {
        const checkout = execFileSync("git", ["-C", source, "worktree", "list", "--porcelain"], { encoding: "utf8" })
          .split("\n").find(line => line.startsWith("worktree ") && line.endsWith("/" + flag))!.slice(9);
        expect(readFileSync(join(checkout, "README.md"), "utf8")).toBe("uncommitted local change");
        expect(existsSync(join(checkout, "node_modules"))).toBe(true);
        expect(branches).toContain(flag);
      }
    });

    it("defers managed cleanup for a running lane, queued message or pending continuation even with explicit inventory", () => {
      const { database, env, directory, source, identity, addDependencies, addWorktree } = managedFixture();
      const checkout = addWorktree("pending-work");
      const dependencies = addDependencies(checkout);
      const db = openDb(database, { databaseRole: "interactive" });
      try {
        const explicit = { ...env, REAP_WORKTREE_REPOS: source, REAP_DETACHED_CHECKOUTS: checkout };
        const lane = db.acquireLock(identity.surfaceIdentity, identity.chatKey, false)!;
        expect(lane).toBeTruthy();
        expect(run(explicit).stdout).toContain("managed conversation cleanup deferred");
        expect(existsSync(dependencies)).toBe(true);
        db.unlock(lane);
        db.enqueueMsg(identity.surfaceIdentity, identity.chatKey, {
          prompt: "queued", chatId: identity.chatKey, chatType: "acp",
        });
        expect(run(explicit).stdout).toContain("managed conversation cleanup deferred");
        expect(existsSync(dependencies)).toBe(true);
        db.discardPendingMsgs(identity.surfaceIdentity, identity.chatKey);
        const key = "run-continuation:v1:future";
        db.setSetting(key, JSON.stringify({
          version: 1, id: "future", originRunId: "origin", surfaceIdentity: identity.surfaceIdentity,
          chatKey: identity.chatKey, provider: "codex", reason: "resume work",
          requestedAt: new Date().toISOString(), dueAt: new Date(Date.now() + 60_000).toISOString(),
          expiresAt: new Date(Date.now() + 600_000).toISOString(), state: "pending", depth: 1,
          outwardSessionId: "managed-session",
        }));
        expect(run(explicit).stdout).toContain("managed conversation cleanup deferred");
        expect(existsSync(dependencies)).toBe(true);
        db.setSetting(key, null);
        db.raw.prepare("DELETE FROM settings WHERE key = ?").run(key);
      } finally { db.close(); }
      const result = run(env);
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(checkout), result.stdout).toBe(false);
      expect(existsSync(directory)).toBe(true);
    });

    it("reclaims a squash-merged worktree only with exact trusted merged PR proof", () => {
      const { root, env, source, addDependencies, addWorktree } = managedFixture();
      const checkout = addWorktree("squashed");
      writeFileSync(join(checkout, "change.txt"), "squash me");
      execFileSync("git", ["-C", checkout, "add", "change.txt"]);
      execFileSync("git", ["-C", checkout, "commit", "-q", "-m", "feature"]);
      const tip = execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      execFileSync("git", ["-C", source, "merge", "--squash", "squashed"]);
      execFileSync("git", ["-C", source, "commit", "-q", "-m", "squash merged"]);
      const merged = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      execFileSync("git", ["-C", source, "update-ref", "refs/remotes/origin/main", merged]);
      execFileSync("git", ["-C", source, "remote", "set-url", "origin", "https://github.com/example/repo.git"]);
      const deps = addDependencies(checkout);
      const bin = join(root, "bin");
      mkdirSync(bin);
      const curl = join(bin, "curl");
      writeFileSync(curl, [
        "#!/usr/bin/env bash",
        "config=$(cat)",
        'if [[ "$REAP_TEST_REQUIRE_AUTH" == 1 && "$config" != *"Authorization: Bearer fixture-token"* ]]; then exit 22; fi',
        'url="${@: -1}"',
        'case "$url" in',
        '  */repos/example/repo) printf \'%s\\n\' \'{"full_name":"example/repo","default_branch":"main"}\' ;;',
        '  */branches/main) printf \'{"commit":{"sha":"%s"}}\\n\' "$REAP_TEST_MERGE" ;;',
        '  */compare/*) printf \'{"status":"diverged"}\\n\' ;;',
        '  */commits/*/pulls*) printf \'[{"head":{"sha":"%s"},"merged_at":"2026-11-24T12:00:00Z","merge_commit_sha":"%s","base":{"ref":"main","repo":{"full_name":"example/repo"}}}]\\n\' "$REAP_TEST_PR_HEAD" "$REAP_TEST_MERGE" ;;',
        '  *) exit 1 ;;',
        'esac',
      ].join("\n") + "\n");
      chmodSync(curl, 0o755);
      const proofEnv = { ...env, GH_TOKEN: "", GITHUB_TOKEN: "", PATH: bin + ":" + process.env.PATH, REAP_TEST_MERGE: merged };
      const wrong = run({ ...proofEnv, REAP_TEST_PR_HEAD: merged });
      expect(wrong.status, wrong.stderr).toBe(0);
      expect(existsSync(deps)).toBe(true);
      const publicPlan = run({ ...proofEnv, REAP_TEST_PR_HEAD: tip }, ["--dry-run"]);
      expect(publicPlan.status, publicPlan.stderr).toBe(0);
      expect(publicPlan.stdout).toContain("would remove worktree (merged+clean): " + checkout);
      const inaccessible = run({ ...proofEnv, REAP_TEST_PR_HEAD: tip, REAP_TEST_REQUIRE_AUTH: "1" });
      expect(inaccessible.status, inaccessible.stderr).toBe(0);
      expect(existsSync(deps)).toBe(true);
      const helper = join(bin, "credential-helper");
      writeFileSync(helper, "#!/usr/bin/env bash\ninput=$(cat)\n[[ \"$1\" == get && \"$input\" == *path=example/repo.git* ]] || exit 1\nprintf 'username=x-access-token\\npassword=fixture-token\\n'\n");
      chmodSync(helper, 0o755);
      execFileSync("git", ["-C", source, "config", "credential.helper", helper]);
      const correct = run({ ...proofEnv, REAP_TEST_PR_HEAD: tip, REAP_TEST_REQUIRE_AUTH: "1" });
      expect(correct.status, correct.stderr).toBe(0);
      expect(existsSync(checkout), correct.stdout).toBe(false);
      expect(execFileSync("git", ["-C", source, "branch", "--list", "squashed"], { encoding: "utf8" })).toBe("");
    });

    it("preserves a merged dependency target referenced by another conversation", () => {
      const { env, database, source, addDependencies, addWorktree } = managedFixture();
      const target = addWorktree("shared-target");
      const dependencies = addDependencies(target);
      const other = { surfaceIdentity: "acp:outward", chatKey: "acp:consumer" };
      const directory = ensureConversationDirectory(source, other);
      const db = openDb(database, { databaseRole: "interactive" });
      new OutwardAcpSessionRepository(db.raw).create({
        sessionId: "consumer-session", conversationId: other.chatKey, cwd: source, executionCwd: directory,
      });
      db.close();
      const consumer = join(directory, "consumer");
      execFileSync("git", ["-C", source, "worktree", "add", "-q", "-b", "consumer", consumer]);
      symlinkSync(dependencies, join(consumer, "node_modules"));
      writeFileSync(join(consumer, "keep.txt"), "dirty");
      const dry = run(env, ["--dry-run"]);
      expect(dry.status, dry.stderr).toBe(0);
      expect(dry.stdout).toContain("shared dependency target");
      expect(dry.stdout).not.toContain("would remove worktree (merged+clean): " + target);
      const result = run(env);
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(dependencies)).toBe(true);
      expect(readFileSync(join(consumer, "node_modules", "cached"), "utf8")).toBe("reproducible");
      expect(existsSync(join(consumer, "keep.txt"))).toBe(true);
    });

    it("uses actual upstream HEAD instead of a stale local tracking ref", () => {
      const { env, source, addWorktree } = managedFixture();
      const checkout = addWorktree("not-yet-fetched");
      writeFileSync(join(checkout, "integrated.txt"), "new upstream commit");
      execFileSync("git", ["-C", checkout, "add", "integrated.txt"]);
      execFileSync("git", ["-C", checkout, "commit", "-q", "-m", "feature"]);
      execFileSync("git", ["-C", source, "merge", "--ff-only", "not-yet-fetched"]);
      const before = execFileSync("git", ["-C", source, "rev-parse", "refs/remotes/origin/main"], { encoding: "utf8" });
      const result = run(env);
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(checkout), result.stdout).toBe(false);
      expect(execFileSync("git", ["-C", source, "rev-parse", "refs/remotes/origin/main"], { encoding: "utf8" })).toBe(before);
    });

    it("does not defer safe cleanup because an unrelated conversation owns a lane", () => {
      const { database, env, addWorktree } = managedFixture();
      const checkout = addWorktree("idle-work");
      const db = openDb(database, { databaseRole: "interactive" });
      const lane = db.acquireLock("acp:outward", "acp:other", false)!;
      try {
        const result = run(env);
        expect(result.status, result.stderr).toBe(0);
        expect(existsSync(checkout), result.stdout).toBe(false);
        expect(db.ownsLock(lane)).toBe(true);
      } finally {
        db.unlock(lane);
        db.close();
      }
    });

    it("scopes a linked receipt to its Run and defers an ambiguous dispatch", () => {
      const { database, env, addWorktree } = managedFixture();
      const checkout = addWorktree("receipt-idle");
      const db = openDb(database, { databaseRole: "interactive" });
      try {
        const receipt = db.createEventReceipt({
          event_id: "receipt-test", source: "health", event_kind: "health",
          idempotency_key: "receipt-test", received_at: new Date().toISOString(),
          occurred_at: new Date().toISOString(), payload_json: "{}", authority_scope: "fixture",
        });
        expect(db.claimEventReceiptDispatch(receipt.id)).toBe(true);
        const deferred = run(env);
        expect(deferred.status, deferred.stderr).toBe(0);
        expect(deferred.stdout).toContain("managed conversation cleanup deferred");
        expect(existsSync(checkout)).toBe(true);
        db.insertRun("unrelated-receipt-run", { surfaceIdentity: "acp:outward", chatKey: "acp:other" }, "codex");
        db.linkEventReceiptRun(receipt.id, "unrelated-receipt-run");
        const result = run(env);
        expect(result.status, result.stderr).toBe(0);
        expect(existsSync(checkout), result.stdout).toBe(false);
      } finally { db.close(); }
    });

    it("discovers a new persisted messaging conversation without scanning an unowned sibling", () => {
      const { database, env, source, origin, addDependencies } = managedFixture();
      const identity = { surfaceIdentity: "telegram:fixture", chatKey: "123" };
      const directory = ensureConversationDirectory(source, identity);
      const unowned = ensureConversationDirectory(source, { surfaceIdentity: "telegram:fixture", chatKey: "999" });
      const db = openDb(database, { databaseRole: "interactive" });
      db.setSetting(conversationDirectorySettingKey(identity), directory);
      db.close();
      const clone = (parent: string) => {
        const checkout = join(parent, "clone");
        execFileSync("git", ["clone", "-q", "--no-hardlinks", source, checkout]);
        execFileSync("git", ["-C", checkout, "remote", "set-url", "origin", origin]);
        return addDependencies(checkout);
      };
      const eligible = clone(directory);
      const notOwned = clone(unowned);
      const result = run(env);
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(eligible), result.stdout).toBe(false);
      expect(existsSync(notOwned)).toBe(true);
    });

    it("accepts a schema-current interactive database with outward_acp_sessions", () => {
      const { env } = realFixture();
      const result = run(env);
      expect(result.stderr).not.toContain("unknown=[outward_acp_sessions]");
      expect(result.stderr).not.toContain("ACP telemetry retention failed");
      expect(result.status, result.stderr).toBe(0);
    });

    it("still rejects an unknown table in the interactive database", () => {
      const { database, env } = realFixture();
      const raw = new Database(database);
      raw.exec("CREATE TABLE surprise_table(id INTEGER PRIMARY KEY)");
      raw.close();
      const result = run(env);
      expect(result.stderr).toContain("unknown=[surprise_table]");
      expect(result.stderr).toContain("ACP telemetry retention failed");
      expect(result.status).toBe(1);
    });

    it("fails explicitly, without a broad fallback, when the project root is missing", () => {
      const { root, env } = realFixture();
      const { BRIDGE_ACP_WORKSPACE_ROOT: _root, ...rest } = env;
      const result = run({ ...rest, BRIDGE_PROJECT_DIR: join(root, "gone") });
      expect(result.stderr).toContain("ENOENT");
      expect(result.stderr).toContain("ACP maintenance failed");
      expect(result.status).toBe(1);
    });

    it("runs ACP maintenance when the project root resolves", () => {
      const { root, env } = realFixture();
      const { BRIDGE_ACP_WORKSPACE_ROOT: _root, ...rest } = env;
      const result = run({ ...rest, BRIDGE_PROJECT_DIR: root });
      expect(result.stderr).not.toContain("ACP maintenance failed");
      expect(result.status, result.stderr).toBe(0);
    });
  });
});
