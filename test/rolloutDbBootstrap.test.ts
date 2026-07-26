import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_VERSION } from "../src/db/schema.js";

// Issue #135 Phase 4C.3: `rollout-db.ts bootstrap` mode for genuinely missing
// production databases. Distinct from `migrate` (which requires the file to
// already exist): bootstrap creates a brand-new database at exactly
// CURRENT_SCHEMA_VERSION via the same real migration plan every other
// database goes through (reusing openDb()'s existing missing-file path),
// validates it (integrity, foreign keys, exact schema version) before ever
// publishing it, and publishes with atomic no-replace semantics (link() +
// unlink(), not rename()) so a destination that appears concurrently is
// never silently overwritten. Accepts exactly one role/path target per
// invocation — never a loop over several, so success/failure is an
// unambiguous, atomic outcome for the whole process.

const migrationScript = fileURLToPath(new URL("../scripts/rollout-db.ts", import.meta.url));
const tsxCli = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "rollout-db-bootstrap-"));
  dirs.push(dir);
  return dir;
}

function bootstrapArgs(path: string, role = "worker"): string[] {
  return ["--db", path, "--role", role, "--confirm-new-role", path];
}

function runBootstrap(args: string[], env: Record<string, string> = {}): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [tsxCli, migrationScript, "bootstrap", ...args], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err: any) {
    return { status: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

function runProvenanceCheck(path: string, role: string, installationId: string): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [tsxCli, migrationScript, "verify-provenance", "--db", path, "--role", role, "--installation-id", installationId], {
      encoding: "utf8",
      env: { ...process.env },
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err: any) {
    return { status: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

/** Runs with AGENT_BRIDGE_BOOTSTRAP_TEST_MODE=1 set, for the test-only fault-injection hooks. */
function runBootstrapTestMode(args: string[], env: Record<string, string> = {}) {
  return runBootstrap(args, { AGENT_BRIDGE_BOOTSTRAP_TEST_MODE: "1", ...env });
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("rollout-db.ts bootstrap", () => {
  it("creates a brand-new database at CURRENT_SCHEMA_VERSION and records installation provenance", () => {
    const dir = tempDir();
    const dbPath = join(dir, "bridge.sqlite");
    const evidencePath = join(dir, "evidence.json");
    const res = runBootstrap([...bootstrapArgs(dbPath, "worker"), "--evidence", evidencePath], { AGENT_BRIDGE_INSTALLATION_ID: "install-test" });
    expect(res.status, res.stderr).toBe(0);
    expect(existsSync(dbPath)).toBe(true);
    const db = new Database(dbPath, { readonly: true });
    expect(db.pragma("user_version", { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    expect(db.prepare("SELECT value FROM settings WHERE key = ?").get("agent_bridge_installation_id")).toEqual({ value: "install-test" });
    expect(db.prepare("SELECT value FROM settings WHERE key = ?").get("agent_bridge_database_provenance")).toBeTruthy();
    db.close();
    expect(existsSync(`${dbPath}.provenance.json`)).toBe(true);
    expect(JSON.parse(readFileSync(`${dbPath}.provenance.json`, "utf8")).databaseSha256).toMatch(/^[a-f0-9]{64}$/);
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
    expect(evidence.mode).toBe("bootstrap");
    expect(evidence.databases[0].role).toBe("worker");
    expect(evidence.databases[0].path).toBe(dbPath);
  });

  it("verifies the complete installation provenance contract", () => {
    const dir = tempDir();
    const dbPath = join(dir, "bridge.sqlite");
    const res = runBootstrap(bootstrapArgs(dbPath, "worker"), { AGENT_BRIDGE_INSTALLATION_ID: "install-test" });
    expect(res.status, res.stderr).toBe(0);
    expect(runProvenanceCheck(dbPath, "worker", "install-test").status).toBe(0);
    expect(runProvenanceCheck(dbPath, "interactive", "install-test").status).not.toBe(0);
    expect(runProvenanceCheck(dbPath, "worker", "install-other").status).not.toBe(0);
  });

  it("rejects an unrecognized role name", () => {
    const dir = tempDir();
    const dbPath = join(dir, "bridge.sqlite");
    const res = runBootstrap(bootstrapArgs(dbPath, "not-a-real-role"));
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/--role/);
    expect(existsSync(dbPath)).toBe(false);
  });

  it("refuses to bootstrap a database that already exists", () => {
    const dir = tempDir();
    const dbPath = join(dir, "bridge.sqlite");
    writeFileSync(dbPath, "not a database");
    const res = runBootstrap(bootstrapArgs(dbPath));
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/already exists/i);
    expect(readFileSync(dbPath, "utf8")).toBe("not a database");
  });

  it("refuses when the destination is a symlink, even a dangling one (existsSync would miss this)", () => {
    const dir = tempDir();
    const dbPath = join(dir, "bridge.sqlite");
    symlinkSync(join(dir, "nowhere.sqlite"), dbPath);
    const res = runBootstrap(bootstrapArgs(dbPath));
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/already exists/i);
  });

  it("requires --confirm-new-role to match the exact target path", () => {
    const dir = tempDir();
    const dbPath = join(dir, "bridge.sqlite");
    const res = runBootstrap(["--db", dbPath, "--role", "worker", "--confirm-new-role", join(dir, "other.sqlite")]);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/confirm-new-role/i);
    expect(existsSync(dbPath)).toBe(false);
  });

  it("refuses without --confirm-new-role at all", () => {
    const dir = tempDir();
    const dbPath = join(dir, "bridge.sqlite");
    const res = runBootstrap(["--db", dbPath, "--role", "worker"]);
    expect(res.status).not.toBe(0);
    expect(existsSync(dbPath)).toBe(false);
  });

  it("refuses without --role at all", () => {
    const dir = tempDir();
    const dbPath = join(dir, "bridge.sqlite");
    const res = runBootstrap(["--db", dbPath, "--confirm-new-role", dbPath]);
    expect(res.status).not.toBe(0);
    expect(existsSync(dbPath)).toBe(false);
  });

  it("refuses a second --db, --role, or --confirm-new-role — exactly one target per invocation", () => {
    // Regression: sequential multi-target bootstrap could partially commit
    // (an earlier target publishes, a later one fails, and the invocation
    // exits nonzero having already mutated disk state). Exactly one target
    // per invocation makes success/failure unambiguous for the whole
    // process; bootstrapping several new roles means separately-invoked,
    // separately-confirmed runs.
    const dir = tempDir();
    const first = join(dir, "a.sqlite");
    const second = join(dir, "b.sqlite");
    const res = runBootstrap([...bootstrapArgs(first, "discord"), ...bootstrapArgs(second, "health")]);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/exactly one/i);
    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(false);
  });

  it("refuses when the parent directory is a symlink", () => {
    const dir = tempDir();
    const realDir = join(dir, "real");
    mkdirSync(realDir);
    const symlinkedDir = join(dir, "linked");
    symlinkSync(realDir, symlinkedDir);
    const dbPath = join(symlinkedDir, "bridge.sqlite");
    const res = runBootstrap(bootstrapArgs(dbPath));
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/missing or symlinked/i);
    expect(existsSync(join(realDir, "bridge.sqlite"))).toBe(false);
  });

  it("refuses when the parent directory is world-writable", () => {
    const dir = tempDir();
    const unsafeDir = join(dir, "unsafe");
    mkdirSync(unsafeDir, { mode: 0o777 });
    execFileSync("chmod", ["0777", unsafeDir]);
    const dbPath = join(unsafeDir, "bridge.sqlite");
    const res = runBootstrap(bootstrapArgs(dbPath));
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/writable/i);
  });

  it("refuses when the parent directory is missing, creating nothing", () => {
    const dir = tempDir();
    const missingDir = join(dir, "does-not-exist");
    const dbPath = join(missingDir, "bridge.sqlite");
    const res = runBootstrap(bootstrapArgs(dbPath));
    expect(res.status).not.toBe(0);
    expect(existsSync(missingDir)).toBe(false);
  });

  it("leaves no temp litter when the target is already occupied by a directory", () => {
    const dir = tempDir();
    const dbPath = join(dir, "bridge.sqlite");
    mkdirSync(dbPath);
    const res = runBootstrap(bootstrapArgs(dbPath));
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/already exists/i);
    const leftoverEntries = readdirSync(dir).filter((name) => name !== "bridge.sqlite");
    expect(leftoverEntries, `unexpected leftovers: ${leftoverEntries.join(", ")}`).toEqual([]);
  });

  it("never creates a missing parent directory", () => {
    const dir = tempDir();
    const missingDir = join(dir, "does-not-exist");
    const dbPath = join(missingDir, "bridge.sqlite");
    const res = runBootstrap(bootstrapArgs(dbPath));
    expect(res.status).not.toBe(0);
    expect(existsSync(missingDir)).toBe(false);
  });

  it("writes evidence with role, path, and current-schema evidence when --evidence is provided", () => {
    const dir = tempDir();
    const dbPath = join(dir, "bridge.sqlite");
    const evidencePath = join(dir, "evidence.json");
    const res = runBootstrap([...bootstrapArgs(dbPath, "health"), "--evidence", evidencePath]);
    expect(res.status, res.stderr).toBe(0);
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
    expect(evidence.mode).toBe("bootstrap");
    expect(evidence.databases[0]).toMatchObject({
      path: dbPath,
      role: "health",
      schema: "current",
      schemaVersion: CURRENT_SCHEMA_VERSION,
      integrity: "ok",
    });
  });

  describe("test-only fault-injection hooks are gated behind AGENT_BRIDGE_BOOTSTRAP_TEST_MODE", () => {
    it("a stray hook variable does nothing without AGENT_BRIDGE_BOOTSTRAP_TEST_MODE=1 (production-reachability regression)", () => {
      // Regression: the hooks used to be unconditional environment-variable
      // checks — reachable in a real production invocation just because a
      // stray/leaked variable happened to be set (e.g. by a misconfigured
      // wrapper or a leftover from a prior test run in the same shell).
      // Without the explicit test-mode flag, the hook must be a complete
      // no-op: bootstrap must succeed normally, not fail or misbehave.
      const dir = tempDir();
      const dbPath = join(dir, "bridge.sqlite");
      const res = runBootstrap(bootstrapArgs(dbPath), { AGENT_BRIDGE_BOOTSTRAP_TEST_PRE_PUBLISH_OCCUPY: dbPath });
      expect(res.status, res.stderr).toBe(0);
      expect(readFileSync(dbPath, "utf8")).not.toBe("concurrently created by a different process\n");
      const db = new Database(dbPath, { readonly: true });
      expect(db.pragma("user_version", { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
      db.close();
    });

    it("cleans up the temp database and its WAL/SHM sidecars when migration itself fails", () => {
      // AGENT_BRIDGE_BOOTSTRAP_TEST_FORCE_MIGRATION_FAILURE pre-creates a
      // file at the exact temp path with an unsupported future schema
      // version just before openDb() is called on it, so the existing
      // version-gate in openDb() itself rejects it — a real migration-time
      // failure, not a simulated one — proving cleanup runs and no debris
      // survives at either path.
      const dir = tempDir();
      const dbPath = join(dir, "bridge.sqlite");
      const res = runBootstrapTestMode(bootstrapArgs(dbPath), { AGENT_BRIDGE_BOOTSTRAP_TEST_FORCE_MIGRATION_FAILURE: dbPath });
      expect(res.status).not.toBe(0);
      expect(res.stderr).toMatch(/unsupported database schema version/i);
      expect(existsSync(dbPath)).toBe(false);
      const leftoverEntries = readdirSync(dir);
      expect(leftoverEntries, `unexpected leftovers: ${leftoverEntries.join(", ")}`).toEqual([]);
    });

    it("cleans up when post-migration validation fails (defense-in-depth: schema version tampered with before publish)", () => {
      const dir = tempDir();
      const dbPath = join(dir, "bridge.sqlite");
      const res = runBootstrapTestMode(bootstrapArgs(dbPath), { AGENT_BRIDGE_BOOTSTRAP_TEST_FORCE_INVALID_SCHEMA: dbPath });
      expect(res.status).not.toBe(0);
      expect(res.stderr).toMatch(/did not reach CURRENT_SCHEMA_VERSION/i);
      expect(existsSync(dbPath)).toBe(false);
      const leftoverEntries = readdirSync(dir);
      expect(leftoverEntries, `unexpected leftovers: ${leftoverEntries.join(", ")}`).toEqual([]);
    });

    it("refuses to overwrite a destination that appears concurrently between validation and publication (atomic no-replace)", () => {
      const dir = tempDir();
      const dbPath = join(dir, "bridge.sqlite");
      const res = runBootstrapTestMode(bootstrapArgs(dbPath), { AGENT_BRIDGE_BOOTSTRAP_TEST_PRE_PUBLISH_OCCUPY: dbPath });
      expect(res.status).not.toBe(0);
      expect(res.stderr).toMatch(/concurrently/i);
      expect(readFileSync(dbPath, "utf8")).toBe("concurrently created by a different process\n");
      const leftoverEntries = readdirSync(dir).filter((name) => name !== "bridge.sqlite");
      expect(leftoverEntries, `unexpected leftovers: ${leftoverEntries.join(", ")}`).toEqual([]);
    });
  });

  it("recovers from a stale temp file left by a previous, uncleanly-interrupted attempt with no destination yet (SIGKILL/reboot before link())", () => {
    // Simulates SIGKILL or a machine reboot before the atomic link() ever
    // ran, leaving orphaned temp debris and no destination. A fresh
    // bootstrap attempt against the *same target* must opportunistically
    // clean it up (safe, since it only ever runs under the shared rollout
    // lock) rather than leaving it to accumulate forever.
    const dir = tempDir();
    const dbPath = join(dir, "bridge.sqlite");
    const staleTemp = join(dir, ".bootstrap-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bridge.sqlite");
    writeFileSync(staleTemp, "stale debris from an unclean previous attempt\n");
    writeFileSync(`${staleTemp}-wal`, "stale wal\n");
    const res = runBootstrap(bootstrapArgs(dbPath));
    expect(res.status, res.stderr).toBe(0);
    // bridge.sqlite-wal/-shm are expected, harmless residue of the
    // published WAL-mode database's own subsequent evidence read (SQLite
    // creates the shared-memory index on any open, even read-only, of a
    // WAL-journaled database) — not stale debris. What this test actually
    // proves is that the *stale temp name* is gone.
    const staleEntries = readdirSync(dir).filter((name) => name.startsWith(".bootstrap-"));
    expect(staleEntries, `unexpected stale temp debris: ${staleEntries.join(", ")}`).toEqual([]);
    expect(existsSync(dbPath)).toBe(true);
  });

  it("recovers a stale hard link left after a successful publish (SIGKILL/reboot between link() and unlink()), even though the destination already exists", () => {
    // Reproduces the exact documented post-commit interruption state: the
    // destination exists and is fully valid (link() succeeded), but the
    // temp name was never unlinked. A real hard link to the SAME inode as
    // the destination is what a genuine SIGKILL/reboot in that window
    // leaves behind — not just a same-named file. cleanupStalePostCommitLink()
    // must recover it even though pathOccupied() would otherwise refuse
    // immediately, and the bootstrap invocation still correctly refuses
    // afterward with "already exists" (this database is not missing).
    const dir = tempDir();
    const dbPath = join(dir, "bridge.sqlite");
    const first = runBootstrap(bootstrapArgs(dbPath));
    expect(first.status, first.stderr).toBe(0);
    const staleLink = join(dir, ".bootstrap-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-bridge.sqlite");
    execFileSync("ln", [dbPath, staleLink]);
    expect(existsSync(staleLink)).toBe(true);

    const second = runBootstrap(bootstrapArgs(dbPath));
    expect(second.status).not.toBe(0);
    expect(second.stderr).toMatch(/already exists/i);
    expect(existsSync(staleLink), "stale post-commit hard link should have been recovered").toBe(false);
    expect(existsSync(dbPath)).toBe(true);
    const db = new Database(dbPath, { readonly: true });
    expect(db.pragma("user_version", { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    db.close();
  });

  it("fails closed (does not delete) when a stale-named temp file shares the destination's name but not its inode", () => {
    // A name match with a *different* inode is not ordinary leftover
    // debris — it's an unexpected state that needs manual operator review,
    // not automatic deletion. Proves the inode check is load-bearing, not
    // just a name-pattern match.
    const dir = tempDir();
    const dbPath = join(dir, "bridge.sqlite");
    const first = runBootstrap(bootstrapArgs(dbPath));
    expect(first.status, first.stderr).toBe(0);
    const unrelatedTemp = join(dir, ".bootstrap-cccccccccccccccccccccccccccccccc-bridge.sqlite");
    writeFileSync(unrelatedTemp, "not actually linked to the destination\n");

    const second = runBootstrap(bootstrapArgs(dbPath));
    expect(second.status).not.toBe(0);
    expect(second.stderr).toMatch(/not its inode|manual operator review/i);
    expect(existsSync(unrelatedTemp), "mismatched-inode file must not be silently deleted").toBe(true);
  });

  it("cleans up on SIGTERM received after migration, before validation (checkpoint 1)", async () => {
    // AGENT_BRIDGE_BOOTSTRAP_TEST_PAUSE_AT=post-migration extends the
    // first real, unconditional production checkpoint so the test can
    // deterministically observe the mid-flight state and inject a signal
    // there. Once the pause file appears, the temp file is provably on
    // disk; sending SIGTERM at that point and confirming full cleanup
    // proves withSignalCleanup() actually runs at a real production
    // checkpoint, not just under an artificial mechanism.
    const dir = tempDir();
    const dbPath = join(dir, "bridge.sqlite");
    const pauseFile = join(dir, ".pause-signal");
    const child = spawn(process.execPath, [
      tsxCli, migrationScript, "bootstrap",
      ...bootstrapArgs(dbPath),
    ], {
      env: {
        ...process.env,
        AGENT_BRIDGE_BOOTSTRAP_TEST_MODE: "1",
        AGENT_BRIDGE_BOOTSTRAP_TEST_PAUSE_AT: "post-migration",
        AGENT_BRIDGE_BOOTSTRAP_TEST_PAUSE_FILE: pauseFile,
      },
    });

    try {
      const deadline = Date.now() + 8000;
      while (!existsSync(pauseFile) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(existsSync(pauseFile), "child never reached the pause point").toBe(true);
      const tempFilesWhilePaused = readdirSync(dir).filter((name) => name.startsWith(".bootstrap-"));
      expect(tempFilesWhilePaused.length, "expected a temp database on disk while paused").toBeGreaterThan(0);
      expect(existsSync(dbPath), "destination must not exist yet at this checkpoint").toBe(false);

      child.kill("SIGTERM");
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.on("exit", (code, signal) => resolve({ code, signal }));
      });
      // withSignalCleanup() exits explicitly with the conventional 128+15
      // code after cleanup, rather than re-raising the raw signal (see its
      // comment for why the naive re-kill approach isn't reliable).
      expect(exit.code, `expected the conventional SIGTERM exit code, got code=${exit.code} signal=${exit.signal}`).toBe(143);
    } finally {
      if (!child.killed) child.kill("SIGKILL");
    }

    expect(existsSync(dbPath)).toBe(false);
    const leftoverEntries = readdirSync(dir).filter((name) => name !== ".pause-signal");
    expect(leftoverEntries, `unexpected leftovers: ${leftoverEntries.join(", ")}`).toEqual([]);
  }, 15000);

  it("cleans up on SIGTERM received after validation, before the commit window (checkpoint 2)", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "bridge.sqlite");
    const pauseFile = join(dir, ".pause-signal");
    const child = spawn(process.execPath, [
      tsxCli, migrationScript, "bootstrap",
      ...bootstrapArgs(dbPath),
    ], {
      env: {
        ...process.env,
        AGENT_BRIDGE_BOOTSTRAP_TEST_MODE: "1",
        AGENT_BRIDGE_BOOTSTRAP_TEST_PAUSE_AT: "post-validation",
        AGENT_BRIDGE_BOOTSTRAP_TEST_PAUSE_FILE: pauseFile,
      },
    });

    try {
      const deadline = Date.now() + 8000;
      while (!existsSync(pauseFile) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(existsSync(pauseFile), "child never reached the pause point").toBe(true);
      expect(existsSync(dbPath), "destination must not exist yet at this checkpoint").toBe(false);

      child.kill("SIGTERM");
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.on("exit", (code, signal) => resolve({ code, signal }));
      });
      expect(exit.code).toBe(143);
    } finally {
      if (!child.killed) child.kill("SIGKILL");
    }

    expect(existsSync(dbPath)).toBe(false);
    const leftoverEntries = readdirSync(dir).filter((name) => name !== ".pause-signal");
    expect(leftoverEntries, `unexpected leftovers: ${leftoverEntries.join(", ")}`).toEqual([]);
  }, 15000);

  it("reports the committed (already-published) outcome, not an ambiguous failure, when SIGTERM arrives after link() but before unlink()", async () => {
    // AGENT_BRIDGE_BOOTSTRAP_TEST_PAUSE_AT=post-commit is test-only — it
    // never awaits in production (see testPause()'s doc comment) — and
    // exists solely to prove the withSignalCleanup() committed-state branch
    // reports success, not "cleaned up, nothing happened", since by this
    // point the destination is genuinely, validly published.
    const dir = tempDir();
    const dbPath = join(dir, "bridge.sqlite");
    const pauseFile = join(dir, ".pause-signal");
    const child = spawn(process.execPath, [
      tsxCli, migrationScript, "bootstrap",
      ...bootstrapArgs(dbPath),
    ], {
      env: {
        ...process.env,
        AGENT_BRIDGE_BOOTSTRAP_TEST_MODE: "1",
        AGENT_BRIDGE_BOOTSTRAP_TEST_PAUSE_AT: "post-commit",
        AGENT_BRIDGE_BOOTSTRAP_TEST_PAUSE_FILE: pauseFile,
      },
    });

    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    try {
      const deadline = Date.now() + 8000;
      while (!existsSync(pauseFile) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(existsSync(pauseFile), "child never reached the pause point").toBe(true);
      // By this checkpoint link() has already succeeded — the destination
      // must already exist, unlike the two earlier checkpoints.
      expect(existsSync(dbPath), "destination must already be published at this checkpoint").toBe(true);

      child.kill("SIGTERM");
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.on("exit", (code, signal) => resolve({ code, signal }));
      });
      expect(exit.code).toBe(143);
    } finally {
      if (!child.killed) child.kill("SIGKILL");
    }

    expect(stderr).toMatch(/already published|do NOT retry/i);
    expect(existsSync(dbPath)).toBe(true);
    const db = new Database(dbPath, { readonly: true });
    expect(db.pragma("user_version", { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    db.close();
  }, 15000);

  it("reports the committed outcome, with zero .bootstrap-* debris, when SIGTERM arrives after unlink() during the post-publication evidence read", async () => {
    // Regression for the round-3 review finding: committed-state handling
    // previously ended the instant withSignalCleanup()'s callback returned
    // — before this checkpoint existed, unlink() completing, the signal
    // listeners being removed, and then the fallible evidence read
    // happening *outside* any signal guard at all. AGENT_BRIDGE_BOOTSTRAP_TEST_PAUSE_AT=post-unlink
    // extends the real checkpoint 3 (after unlink(), still inside
    // withSignalCleanup()'s guarded region) so this can be proven directly:
    // committed-state message, a valid destination, and — critically — the
    // temp name is already gone by this point (unlink() already ran), so
    // there must be zero .bootstrap-* debris left anywhere.
    const dir = tempDir();
    const dbPath = join(dir, "bridge.sqlite");
    const pauseFile = join(dir, ".pause-signal");
    const child = spawn(process.execPath, [
      tsxCli, migrationScript, "bootstrap",
      ...bootstrapArgs(dbPath),
    ], {
      env: {
        ...process.env,
        AGENT_BRIDGE_BOOTSTRAP_TEST_MODE: "1",
        AGENT_BRIDGE_BOOTSTRAP_TEST_PAUSE_AT: "post-unlink",
        AGENT_BRIDGE_BOOTSTRAP_TEST_PAUSE_FILE: pauseFile,
      },
    });

    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    try {
      const deadline = Date.now() + 8000;
      while (!existsSync(pauseFile) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(existsSync(pauseFile), "child never reached the pause point").toBe(true);
      expect(existsSync(dbPath), "destination must already be published at this checkpoint").toBe(true);
      // The *main* temp name is gone (unlink() already ran) — only its
      // -wal/-shm sidecars may still be on disk at this exact instant,
      // since removeSidecars(tempPath) is scheduled to run right after
      // this checkpoint in the normal flow. That's expected and fine: the
      // signal handler's committed branch cleans them up regardless of
      // whether the signal lands here or later.
      const mainTempStillPresent = readdirSync(dir).some((name) => /^\.bootstrap-[0-9a-f]{32}-bridge\.sqlite$/.test(name));
      expect(mainTempStillPresent, "unlink() already ran by this checkpoint — the main temp name must be gone").toBe(false);

      child.kill("SIGTERM");
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.on("exit", (code, signal) => resolve({ code, signal }));
      });
      expect(exit.code).toBe(143);
    } finally {
      if (!child.killed) child.kill("SIGKILL");
    }

    expect(stderr).toMatch(/already published|do NOT retry/i);
    expect(existsSync(dbPath)).toBe(true);
    const db = new Database(dbPath, { readonly: true });
    expect(db.pragma("user_version", { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    db.close();
    const leftoverEntries = readdirSync(dir).filter((name) => name !== ".pause-signal");
    const staleDebris = leftoverEntries.filter((name) => name.startsWith(".bootstrap-"));
    expect(staleDebris, `unexpected .bootstrap-* debris: ${staleDebris.join(", ")}`).toEqual([]);
  }, 15000);

  it("recovers an orphaned post-commit sidecar (-wal/-shm with no corresponding main temp file) when the destination already exists", () => {
    // Reproduces the gap between the committed-state signal handler (which
    // only best-effort-removes the main temp hard link and its sidecars
    // immediately) and a later crash that could still leave a sidecar
    // behind with the main temp name already gone. Since a -wal/-shm
    // sidecar is never itself a hard link to the destination, no inode
    // check applies to it — cleanupStalePostCommitLink() must recover it
    // unconditionally once the destination exists, not just when the main
    // temp name is also still present.
    const dir = tempDir();
    const dbPath = join(dir, "bridge.sqlite");
    const first = runBootstrap(bootstrapArgs(dbPath));
    expect(first.status, first.stderr).toBe(0);
    const orphanedWal = join(dir, ".bootstrap-dddddddddddddddddddddddddddddddd-bridge.sqlite-wal");
    const orphanedShm = join(dir, ".bootstrap-dddddddddddddddddddddddddddddddd-bridge.sqlite-shm");
    writeFileSync(orphanedWal, "orphaned wal with no main temp file left\n");
    writeFileSync(orphanedShm, "orphaned shm with no main temp file left\n");

    const second = runBootstrap(bootstrapArgs(dbPath));
    expect(second.status).not.toBe(0);
    expect(second.stderr).toMatch(/already exists/i);
    expect(existsSync(orphanedWal), "orphaned sidecar should have been recovered").toBe(false);
    expect(existsSync(orphanedShm), "orphaned sidecar should have been recovered").toBe(false);
    expect(existsSync(dbPath)).toBe(true);
    const db = new Database(dbPath, { readonly: true });
    expect(db.pragma("user_version", { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    db.close();
  });

  it("leaves a mismatched-inode main file AND both its sidecars completely untouched (two-phase validate-before-delete)", () => {
    // Regression for the round-5 review finding: a single combined
    // group-and-delete pass could remove a stem's sidecars as soon as they
    // were seen in directory iteration (unspecified order), *before* that
    // same stem's main file was later found to be inode-mismatched —
    // deleting part of an unexpected state before the mismatch was even
    // discovered. cleanupStalePostCommitLink() must validate every stem's
    // main file first and only delete anything once every stem has passed,
    // so a mismatched main's own sidecars are never touched either.
    const dir = tempDir();
    const dbPath = join(dir, "bridge.sqlite");
    const first = runBootstrap(bootstrapArgs(dbPath));
    expect(first.status, first.stderr).toBe(0);
    const mismatchedMain = join(dir, ".bootstrap-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee-bridge.sqlite");
    const mismatchedWal = `${mismatchedMain}-wal`;
    const mismatchedShm = `${mismatchedMain}-shm`;
    writeFileSync(mismatchedMain, "not actually linked to the destination\n");
    writeFileSync(mismatchedWal, "sidecar belonging to the mismatched main\n");
    writeFileSync(mismatchedShm, "sidecar belonging to the mismatched main\n");

    const second = runBootstrap(bootstrapArgs(dbPath));
    expect(second.status).not.toBe(0);
    expect(second.stderr).toMatch(/not its inode|manual operator review/i);
    expect(existsSync(mismatchedMain), "mismatched main must not be deleted").toBe(true);
    expect(existsSync(mismatchedWal), "sidecar of a mismatched main must not be deleted").toBe(true);
    expect(existsSync(mismatchedShm), "sidecar of a mismatched main must not be deleted").toBe(true);
    expect(existsSync(dbPath)).toBe(true);
  });
});

describe("rollout-db.ts bootstrap post-publication signal checkpoints (round 5)", () => {
  async function runWithPause(dbPath: string, checkpoint: string, pauseFile: string) {
    return spawn(process.execPath, [
      tsxCli, migrationScript, "bootstrap",
      ...bootstrapArgs(dbPath),
    ], {
      env: {
        ...process.env,
        AGENT_BRIDGE_BOOTSTRAP_TEST_MODE: "1",
        AGENT_BRIDGE_BOOTSTRAP_TEST_PAUSE_AT: checkpoint,
        AGENT_BRIDGE_BOOTSTRAP_TEST_PAUSE_FILE: pauseFile,
      },
    });
  }

  it("reports the committed outcome when SIGTERM arrives after the post-publication inspection read, before evidence is written", async () => {
    // Evidence-file behavior itself (that it's already written by this
    // point) is covered by the "post-evidence" case below; this case
    // doesn't pass --evidence at all, just proving the checkpoint itself.
    const dir = tempDir();
    const dbPath = join(dir, "bridge.sqlite");
    const pauseFile = join(dir, ".pause-signal");
    const child = await runWithPause(dbPath, "post-inspection", pauseFile);

    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    try {
      const deadline = Date.now() + 8000;
      while (!existsSync(pauseFile) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(existsSync(pauseFile), "child never reached the pause point").toBe(true);
      expect(existsSync(dbPath), "destination must already be published at this checkpoint").toBe(true);

      child.kill("SIGTERM");
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.on("exit", (code, signal) => resolve({ code, signal }));
      });
      expect(exit.code).toBe(143);
    } finally {
      if (!child.killed) child.kill("SIGKILL");
    }

    expect(stderr).toMatch(/already published|do NOT retry/i);
    expect(existsSync(dbPath)).toBe(true);
    const db = new Database(dbPath, { readonly: true });
    expect(db.pragma("user_version", { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    db.close();
    const leftoverEntries = readdirSync(dir).filter((name) => name !== ".pause-signal");
    const staleDebris = leftoverEntries.filter((name) => name.startsWith(".bootstrap-"));
    expect(staleDebris, `unexpected .bootstrap-* debris: ${staleDebris.join(", ")}`).toEqual([]);
  }, 15000);

  it("reports the committed outcome and still writes the evidence file when SIGTERM arrives immediately after evidence is written", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "bridge.sqlite");
    const pauseFile = join(dir, ".pause-signal");
    const child = spawn(process.execPath, [
      tsxCli, migrationScript, "bootstrap",
      ...bootstrapArgs(dbPath),
      "--evidence", join(dir, "evidence.json"),
    ], {
      env: {
        ...process.env,
        AGENT_BRIDGE_BOOTSTRAP_TEST_MODE: "1",
        AGENT_BRIDGE_BOOTSTRAP_TEST_PAUSE_AT: "post-evidence",
        AGENT_BRIDGE_BOOTSTRAP_TEST_PAUSE_FILE: pauseFile,
      },
    });

    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    try {
      const deadline = Date.now() + 8000;
      while (!existsSync(pauseFile) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(existsSync(pauseFile), "child never reached the pause point").toBe(true);
      // By this checkpoint the evidence file must already be written.
      expect(existsSync(join(dir, "evidence.json")), "evidence file must already exist at this checkpoint").toBe(true);

      child.kill("SIGTERM");
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.on("exit", (code, signal) => resolve({ code, signal }));
      });
      expect(exit.code).toBe(143);
    } finally {
      if (!child.killed) child.kill("SIGKILL");
    }

    expect(stderr).toMatch(/already published|do NOT retry/i);
    expect(existsSync(dbPath)).toBe(true);
    const evidence = JSON.parse(readFileSync(join(dir, "evidence.json"), "utf8"));
    expect(evidence.databases[0].path).toBe(dbPath);
    const leftoverEntries = readdirSync(dir).filter((name) => name !== ".pause-signal" && name !== "evidence.json");
    const staleDebris = leftoverEntries.filter((name) => name.startsWith(".bootstrap-"));
    expect(staleDebris, `unexpected .bootstrap-* debris: ${staleDebris.join(", ")}`).toEqual([]);
  }, 15000);
});

describe("rollout-db.ts ordinary modes never bootstrap", () => {
  it("inspect never creates a missing database", () => {
    const dir = tempDir();
    const dbPath = join(dir, "bridge.sqlite");
    try {
      execFileSync(process.execPath, [tsxCli, migrationScript, "inspect", "--db", dbPath], { encoding: "utf8" });
      expect.fail("expected inspect to fail on a missing database");
    } catch (err: any) {
      expect(err.status).not.toBe(0);
    }
    expect(existsSync(dbPath)).toBe(false);
  });

  it("validate never creates a missing database", () => {
    const dir = tempDir();
    const dbPath = join(dir, "bridge.sqlite");
    try {
      execFileSync(process.execPath, [tsxCli, migrationScript, "validate", "--db", dbPath], { encoding: "utf8" });
      expect.fail("expected validate to fail on a missing database");
    } catch (err: any) {
      expect(err.status).not.toBe(0);
    }
    expect(existsSync(dbPath)).toBe(false);
  });

  it("an unrecognized mode string is rejected by the usage check, never silently routed to bootstrap logic", () => {
    const dir = tempDir();
    const dbPath = join(dir, "bridge.sqlite");
    try {
      execFileSync(process.execPath, [tsxCli, migrationScript, "bootstrapp", "--db", dbPath, "--role", "worker", "--confirm-new-role", dbPath], { encoding: "utf8" });
      expect.fail("expected an unrecognized mode to fail");
    } catch (err: any) {
      expect(err.status).not.toBe(0);
      expect(err.stderr).toMatch(/usage/i);
    }
    expect(existsSync(dbPath)).toBe(false);
  });
});
