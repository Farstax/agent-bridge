/**
 * PURPOSE: Fail-closed executable boundary for guarded rollout database tooling.
 * INPUTS: rollout-db CLI arguments plus explicitly gated non-production UAT hooks.
 * OUTPUTS: Delegates to rollout-db-impl.ts after sanitizing inherited hook variables.
 * NEIGHBORS: scripts/rollout-agent-bridge.sh, scripts/rollout-db-impl.ts
 * LOGIC: Migration barrier hooks are impossible without an explicit canonical test root and may only target paths inside it.
 */

import { chmodSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

const TEST_ROOT_ENV = "AGENT_BRIDGE_ROLLOUT_TEST_ROOT";
const BARRIER_ENV = "AGENT_BRIDGE_ROLLOUT_TEST_MIGRATE_BARRIER_FILE";
const PAUSE_ENV = "AGENT_BRIDGE_ROLLOUT_TEST_MIGRATE_PAUSE_AFTER_INDEX";

const testRoot = process.env[TEST_ROOT_ENV];
const barrierFile = process.env[BARRIER_ENV];
const pauseAfterIndex = process.env[PAUSE_ENV];

function fail(message: string): never {
  throw new Error(message);
}

if (!testRoot) {
  // Production rollout intentionally executes the implementation as the
  // non-root runtime user and inherits the caller environment. Strip these
  // variables unless the shell helper's explicit test-root boundary is also
  // present, so stray or malicious inherited values can never pause a real
  // migration.
  delete process.env[BARRIER_ENV];
  delete process.env[PAUSE_ENV];
} else {
  if (typeof process.getuid !== "function" || process.getuid() === 0) {
    fail("rollout migration test hooks are forbidden when running as root");
  }
  if (!isAbsolute(testRoot) || realpathSync(testRoot) !== testRoot) {
    fail(`${TEST_ROOT_ENV} must be an existing canonical absolute directory`);
  }
  if (barrierFile) {
    if (!isAbsolute(barrierFile)) {
      fail(`migration barrier file must be an absolute path inside ${TEST_ROOT_ENV}`);
    }
    const canonicalParent = realpathSync(dirname(barrierFile));
    const relativeParent = relative(testRoot, canonicalParent);
    if (relativeParent === ".." || relativeParent.startsWith(`..${sep}`) || isAbsolute(relativeParent)) {
      fail(`migration barrier file must remain inside ${TEST_ROOT_ENV}`);
    }
    if (join(canonicalParent, basename(barrierFile)) !== barrierFile) {
      fail("migration barrier file must be canonical");
    }
  }
  if (pauseAfterIndex !== undefined) {
    const parsed = Number(pauseAfterIndex);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      fail("migration pause index must be a positive integer");
    }
    if (!barrierFile) fail("migration pause index requires a barrier file");
  }
}

/**
 * Offline-exclusion fence (see contain_sqlite_writers in the rollout helper):
 * after writer containment the helper sets each managed database and sidecar
 * to mode 000, so no other process of the runtime user can open one. This tool
 * runs as that owner, so it alone may lift the fence for the duration of one
 * invocation and must restore it on exit. Only a mode of exactly 000 counts as
 * fenced; ordinary databases are never touched.
 */
const fencedPaths = new Map<string, number>();
function liftFence(): void {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length - 1; i += 1) {
    if ((args[i] !== "--db" && args[i] !== "--from") || !args[i + 1].startsWith("/")) continue;
    const base = args[i + 1];
    try {
      if ((statSync(base).mode & 0o777) !== 0) continue;
    } catch {
      continue;
    }
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        if ((statSync(base + suffix).mode & 0o777) === 0) {
          chmodSync(base + suffix, 0o600);
          fencedPaths.set(base + suffix, 0);
        }
      } catch { /* absent sidecar */ }
    }
    fencedPaths.set(base, 0);
    // A relocation copy of a fenced database is itself fenced when the tool exits.
    if (args[i] === "--from") {
      const target = args[args.indexOf("--to") + 1];
      if (target?.startsWith("/")) fencedPaths.set(target, 0);
    }
  }
}
liftFence();
process.on("exit", () => {
  for (const base of fencedPaths.keys()) {
    if (base.endsWith("-wal") || base.endsWith("-shm")) continue;
    for (const suffix of ["", "-wal", "-shm"]) {
      try { chmodSync(base + suffix, 0o000); } catch { /* absent sidecar */ }
    }
  }
});

await import("./rollout-db-impl.js");
