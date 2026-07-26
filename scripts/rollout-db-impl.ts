/**
 * PURPOSE: Inspect, migrate, and validate the root-resolved SQLite inventory used by guarded production rollouts.
 * INPUTS: A rollout phase, evidence path, and an explicit list of existing SQLite database files.
 * OUTPUTS: Metadata-only schema, integrity, queue, and hash evidence.
 * NEIGHBORS: scripts/rollout-agent-bridge.sh, src/db.ts
 * LOGIC: Rejects unknown schemas before mutation, runs existing openDb migrations, and validates the exact current lane/queue columns.
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import Database from "better-sqlite3";
import { openDb, openProductionDb } from "../src/db.js";
import { CURRENT_SCHEMA_VERSION } from "../src/db/schema.js";
import { assertDatabaseForeignKeyIntegrity, assertExactRoleAssignmentSchema } from "../src/db/roleAssignmentsMigration.js";

/** The five canonical database roles (policy doc §4) — structural validity only; the actual role/path allowlist lives in the root-owned bootstrap config, outside this script's scope. */
const VALID_ROLES = new Set(["shared", "discord", "health", "interactive", "worker"]);

type Mode = "inspect" | "checkpoint" | "migrate" | "validate" | "bootstrap";

interface Options {
  mode: Mode;
  databases: string[];
  evidencePath: string | null;
  resolvingUnits: Map<string, string[]>;
}

interface DbEvidence {
  path: string;
  sha256: string;
  integrity: string;
  schemaVersion: number;
  schema: "legacy" | "migratable" | "current";
  legacyQueueCount: number;
  pendingQueueCount: number;
  tables: string[];
  pendingColumns: string[];
  lockColumns: string[];
  resolvingUnits: string[];
  queueStateCounts: Record<string, number>;
  claimStateCounts: Record<string, number>;
  executionLockState: { total: number; active: number };
  claimRunAcquisitionCorrelation: string;
  runLockCorrelation: { queue: Array<Record<string, unknown>>; locks: Array<Record<string, unknown>> };
  deliveryState: Record<string, number>;
  role?: string;
}

const ALLOWED_TABLES = new Set([
  "advisor_attempts", "advisor_calls", "approvals", "bridge_events", "bridge_runs", "bridge_state",
  "compaction_attempts", "conversation_summaries", "conversation_turns", "execution_locks", "feature_plans",
  "github_links", "health_context", "pending_messages", "project_memories", "project_memories_fts",
  "project_memories_fts_config", "project_memories_fts_content", "project_memories_fts_data",
  "project_memories_fts_docsize", "project_memories_fts_idx", "prompts", "settings", "sqlite_sequence",
  "role_assignment_revisions", "role_assignments", "work_item_plans", "work_items", "work_jobs",
]);

const REQUIRED_TABLES = new Set(["bridge_state", "pending_messages", "settings"]);
const CURRENT_ROLE_TABLES = ["role_assignment_revisions", "role_assignments"] as const;
const LEGACY_PENDING_COLUMNS = new Set([
  "id", "chat_key", "prompt", "chat_id", "thread_id", "chat_type", "user_id", "created_at",
]);
const CURRENT_PENDING_COLUMNS = new Set([
  ...LEGACY_PENDING_COLUMNS,
  "surface", "state", "claim_run_id", "claim_acquisition_id", "claimed_at", "attachments_json",
]);
const CURRENT_LOCK_COLUMNS = new Set([
  "surface", "chat_key", "service_id", "run_id", "acquisition_id", "acquired_at", "lease_expires_at",
]);

function parseArgs(argv: string[]): Options {
  const mode = argv.shift() as Mode | undefined;
  if (!mode || !["inspect", "checkpoint", "migrate", "validate"].includes(mode)) {
    throw new Error("usage: rollout-db.ts <inspect|checkpoint|migrate|validate> --db PATH [--db PATH ...]");
  }
  const databases: string[] = [];
  let evidencePath: string | null = null;
  const resolvingUnits = new Map<string, string[]>();
  while (argv.length > 0) {
    const flag = argv.shift();
    const value = argv.shift();
    if (!value) throw new Error(`missing value for ${flag}`);
    if (flag === "--db") databases.push(value);
    else if (flag === "--evidence") evidencePath = value;
    else if (flag === "--resolving-unit") {
      const separator = value.indexOf("=");
      if (separator <= 0 || separator === value.length - 1) {
        throw new Error(`--resolving-unit must be PATH=unit-name, got: ${value}`);
      }
      const path = value.slice(0, separator);
      const unit = value.slice(separator + 1);
      const existing = resolvingUnits.get(path) ?? [];
      existing.push(unit);
      resolvingUnits.set(path, existing);
    }
    else throw new Error(`unknown argument: ${flag}`);
  }
  if (databases.length === 0) throw new Error("at least one --db path is required");
  return { mode, databases, evidencePath, resolvingUnits };
}

interface BootstrapOptions {
  path: string;
  role: string;
  evidencePath: string | null;
}

interface ProvenanceCheckOptions {
  path: string;
  role: string;
  installationId: string;
}

function parseProvenanceCheckArgs(argv: string[]): ProvenanceCheckOptions {
  let path: string | null = null;
  let role: string | null = null;
  let installationId: string | null = null;
  while (argv.length > 0) {
    const flag = argv.shift();
    const value = argv.shift();
    if (!value) throw new Error(`missing value for ${flag}`);
    if (flag === "--db") {
      if (path) throw new Error("verify-provenance accepts exactly one --db");
      path = value;
    } else if (flag === "--role") {
      if (role) throw new Error("verify-provenance accepts exactly one --role");
      if (!VALID_ROLES.has(value)) throw new Error(`--role must be one of ${[...VALID_ROLES].join(", ")}, got: ${value}`);
      role = value;
    } else if (flag === "--installation-id") {
      if (installationId) throw new Error("verify-provenance accepts exactly one --installation-id");
      installationId = value;
    } else {
      throw new Error(`unknown argument: ${flag}`);
    }
  }
  if (!path) throw new Error("--db is required");
  if (!role) throw new Error("--role is required");
  if (!installationId) throw new Error("--installation-id is required");
  return { path, role, installationId };
}

/**
 * Bootstrap's own arg parser (Phase 4C.3, issue #135): exactly one
 * `--db PATH --role NAME --confirm-new-role PATH` triplet per invocation —
 * deliberately not a loop over multiple targets. Sequential multi-target
 * bootstrap can partially commit: an earlier target publishes successfully,
 * a later one fails, and the invocation exits nonzero having already
 * mutated disk state with no way to tell which targets succeeded from the
 * exit code alone. One target per invocation makes success/failure an
 * atomic, unambiguous outcome for the whole process; bootstrapping several
 * new roles means separately-invoked, separately-confirmed runs, each with
 * its own evidence.
 *
 * The role is an explicit expected role (one of the five canonical roles,
 * structurally validated here — the role/path *pair* allowlist itself lives
 * in the root-owned bootstrap config, outside this script) and
 * --confirm-new-role is an exact-match confirmation that the missing file
 * is expected, not a symptom of misconfiguration or accidental deletion,
 * mirroring --expected-commit's exact-match discipline elsewhere in this
 * tooling.
 */
function parseBootstrapArgs(argv: string[]): BootstrapOptions {
  let path: string | null = null;
  let role: string | null = null;
  let confirm: string | null = null;
  let evidencePath: string | null = null;
  while (argv.length > 0) {
    const flag = argv.shift();
    const value = argv.shift();
    if (!value) throw new Error(`missing value for ${flag}`);
    if (flag === "--db") {
      if (path) throw new Error("bootstrap accepts exactly one --db per invocation — invoke separately for each new role");
      path = value;
    } else if (flag === "--role") {
      if (role) throw new Error("bootstrap accepts exactly one --role per invocation");
      if (!VALID_ROLES.has(value)) {
        throw new Error(`--role must be one of ${[...VALID_ROLES].join(", ")}, got: ${value}`);
      }
      role = value;
    } else if (flag === "--confirm-new-role") {
      if (confirm) throw new Error("bootstrap accepts exactly one --confirm-new-role per invocation");
      confirm = value;
    } else if (flag === "--evidence") {
      evidencePath = value;
    } else {
      throw new Error(`unknown argument: ${flag}`);
    }
  }
  if (!path) throw new Error("--db is required");
  if (!role) throw new Error("--role is required");
  if (!confirm) throw new Error("--confirm-new-role is required");
  if (confirm !== path) {
    throw new Error(`--confirm-new-role must exactly match --db (expected "${path}", got "${confirm}")`);
  }
  return { path, role, evidencePath };
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name).sort();
}

function sameSet(values: string[], expected: Set<string>): boolean {
  return values.length === expected.size && values.every((value) => expected.has(value));
}

function countBy<T extends string>(values: T[]): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function digestRows(rows: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

function inspectDatabase(path: string, requireCurrent: boolean, resolvingUnits: string[] = []): DbEvidence {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const integrity = String(db.pragma("integrity_check", { simple: true }));
    if (integrity !== "ok") throw new Error(`integrity check failed for ${path}: ${integrity}`);
    const userVersion = Number(db.pragma("user_version", { simple: true }));
    if (userVersion > CURRENT_SCHEMA_VERSION) {
      throw new Error(`unsupported future schema version ${userVersion} for ${path}`);
    }
    if (!Number.isInteger(userVersion) || userVersion < 0) {
      throw new Error(`invalid schema version ${userVersion} for ${path}`);
    }
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
    const unknownTables = tables.filter((table) => !ALLOWED_TABLES.has(table));
    const missingTables = [...REQUIRED_TABLES].filter((table) => !tables.includes(table));
    if (unknownTables.length > 0 || missingTables.length > 0) {
      throw new Error(`unknown schema for ${path}: unknown=[${unknownTables.join(",")}] missing=[${missingTables.join(",")}]`);
    }
    const pendingColumns = columnNames(db, "pending_messages");
    const invalidPending = pendingColumns.some((column) => !CURRENT_PENDING_COLUMNS.has(column))
      || [...LEGACY_PENDING_COLUMNS].some((column) => !pendingColumns.includes(column));
    if (invalidPending) throw new Error(`unknown schema for ${path}: unsupported pending_messages columns`);
    const lockColumns = tables.includes("execution_locks") ? columnNames(db, "execution_locks") : [];
    const currentPending = sameSet(pendingColumns, CURRENT_PENDING_COLUMNS);
    const currentLocks = sameSet(lockColumns, CURRENT_LOCK_COLUMNS);
    let currentRoleTables = CURRENT_ROLE_TABLES.every((table) => tables.includes(table));
    if (userVersion === CURRENT_SCHEMA_VERSION) {
      try {
        assertExactRoleAssignmentSchema(db);
        assertDatabaseForeignKeyIntegrity(db);
        currentRoleTables = true;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const phase = requireCurrent ? " after migration" : "";
        throw new Error(`unknown schema${phase} for ${path}: ${detail}`);
      }
    }
    const schema = userVersion === 0
      ? "legacy"
      : currentPending && currentLocks && currentRoleTables
        ? "current"
      : sameSet(pendingColumns, LEGACY_PENDING_COLUMNS) && lockColumns.length === 0
        ? "legacy"
        : "migratable";
    if (requireCurrent && schema !== "current") throw new Error(`unknown schema after migration for ${path}: ${schema}`);
    const legacyQueueCount = pendingColumns.includes("surface")
      ? Number((db.prepare("SELECT COUNT(*) AS count FROM pending_messages WHERE surface = 'legacy'").get() as { count: number }).count)
      : Number((db.prepare("SELECT COUNT(*) AS count FROM pending_messages").get() as { count: number }).count);
    const pendingQueueCount = Number((db.prepare("SELECT COUNT(*) AS count FROM pending_messages").get() as { count: number }).count);
    const queueRows = pendingColumns.includes("state")
      ? db.prepare("SELECT id, state, claim_run_id, claim_acquisition_id FROM pending_messages ORDER BY id").all() as Array<Record<string, unknown>>
      : db.prepare("SELECT id FROM pending_messages ORDER BY id").all() as Array<Record<string, unknown>>;
    const queueStateCounts = pendingColumns.includes("state")
      ? countBy((queueRows as Array<{ state: string }>).map((row) => row.state))
      : { legacy: pendingQueueCount };
    const claimStateCounts = pendingColumns.includes("state")
      ? countBy((queueRows as Array<{ state: string }>).filter((row) => row.state === "claimed").map((row) => row.state))
      : {};
    const lockRows = currentLocks
      ? db.prepare("SELECT surface, service_id, run_id, acquisition_id, acquired_at, lease_expires_at FROM execution_locks ORDER BY surface, service_id, run_id, acquisition_id").all()
      : [];
    const executionLockState = { total: lockRows.length, active: lockRows.filter((row) => new Date(String((row as { lease_expires_at: string }).lease_expires_at)).getTime() > Date.now()).length };
    const deliveryState = tables.includes("bridge_runs")
      ? countBy((db.prepare("SELECT status FROM bridge_runs ORDER BY run_id").all() as Array<{ status: string }>).map((row) => row.status))
      : {};
    return {
      path, sha256: hashFile(path), integrity, schemaVersion: userVersion, schema, legacyQueueCount, pendingQueueCount,
      tables, pendingColumns, lockColumns, resolvingUnits, queueStateCounts, claimStateCounts, executionLockState,
      claimRunAcquisitionCorrelation: digestRows({ queueRows, lockRows }),
      runLockCorrelation: { queue: queueRows, locks: lockRows as Array<Record<string, unknown>> }, deliveryState,
    };
  } finally {
    db.close();
  }
}

function sidecarSize(path: string): number {
  try {
    return statSync(path).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

function checkpointDatabase(path: string, resolvingUnits: string[] = []): DbEvidence & {
  walBytesBefore: number;
  walBytesAfter: number;
  checkpointedPages: number;
} {
  const walPath = `${path}-wal`;
  const walBytesBefore = sidecarSize(walPath);
  const db = new Database(path, { fileMustExist: true });
  let checkpointResult: Array<{ busy: number; log: number; checkpointed: number }>;
  try {
    checkpointResult = db.pragma("wal_checkpoint(TRUNCATE)") as Array<{ busy: number; log: number; checkpointed: number }>;
  } finally {
    db.close();
  }
  const result = checkpointResult[0];
  if (!result || result.busy !== 0) {
    throw new Error(`SQLite WAL checkpoint was busy for ${path}`);
  }
  const walBytesAfter = sidecarSize(walPath);
  if (walBytesAfter !== 0) {
    throw new Error(`SQLite WAL checkpoint did not drain the WAL for ${path}: ${walBytesAfter} bytes remain`);
  }
  return {
    ...inspectDatabase(path, false, resolvingUnits),
    walBytesBefore,
    walBytesAfter,
    checkpointedPages: result.checkpointed,
  };
}

/** True if anything at all exists at `path` — including a symlink, even a dangling one. Deliberately lstat-based (not existsSync, which follows symlinks and would report a dangling symlink as "nothing here"). */
function pathOccupied(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/**
 * Same ownership/permission/no-symlink standard already applied to
 * `backup_dir`/`log_dir` by rollout-agent-bridge.sh: canonical, a real
 * directory (not a symlink), not group/world-writable. Root ownership
 * itself is proven at the shell-wrapper layer *before* it drops to the
 * unprivileged runtime user that actually executes this script — the same
 * layering `migrate` mode already relies on — so it is deliberately not
 * re-asserted here.
 */
function validateParentDir(dir: string): void {
  let parentStat;
  try {
    parentStat = lstatSync(dir);
  } catch {
    throw new Error(`parent directory is missing or symlinked: ${dir}`);
  }
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    throw new Error(`parent directory is missing or symlinked: ${dir}`);
  }
  if (realpathSync(dir) !== dir) throw new Error(`parent directory is not canonical: ${dir}`);
  if ((parentStat.mode & 0o022) !== 0) throw new Error(`parent directory must not be group/world writable: ${dir}`);
}

/** Validates the freshly-migrated temp database before it is ever published, per Phase 4C.3's "validate before publication" requirement. */
function validateBootstrapped(tempPath: string): void {
  const db = new Database(tempPath, { readonly: true, fileMustExist: true });
  try {
    const integrity = String(db.pragma("integrity_check", { simple: true }));
    if (integrity !== "ok") throw new Error(`bootstrap integrity check failed for ${tempPath}: ${integrity}`);
    const fkViolations = db.pragma("foreign_key_check") as unknown[];
    if (Array.isArray(fkViolations) && fkViolations.length > 0) {
      throw new Error(`bootstrap left ${fkViolations.length} foreign key violation(s) in ${tempPath}`);
    }
    const userVersion = Number(db.pragma("user_version", { simple: true }));
    if (userVersion !== CURRENT_SCHEMA_VERSION) {
      throw new Error(`bootstrap did not reach CURRENT_SCHEMA_VERSION for ${tempPath}: got ${userVersion}`);
    }
  } finally {
    db.close();
  }
}

function removeSidecars(base: string): void {
  for (const suffix of ["-wal", "-shm"]) {
    try { rmSync(`${base}${suffix}`, { force: true }); } catch { /* best-effort */ }
  }
}

/**
 * Test-only fault-injection hooks, gated so they can never fire against a
 * real production invocation just because a stray environment variable
 * happens to be set: honored only when AGENT_BRIDGE_BOOTSTRAP_TEST_MODE=1
 * is *also* explicitly set, and refused outright when running as root
 * (mirroring the shell rollout tooling's own "test root is forbidden
 * during root execution" rule) — bootstrap itself never runs as root in
 * production (the shell wrapper always drops to the runtime user first),
 * so this is defense in depth against a misconfigured or malicious
 * root-context invocation, not a path this script expects to take.
 */
const BOOTSTRAP_TEST_MODE = process.env.AGENT_BRIDGE_BOOTSTRAP_TEST_MODE === "1";
if (BOOTSTRAP_TEST_MODE && typeof process.getuid === "function" && process.getuid() === 0) {
  throw new Error("AGENT_BRIDGE_BOOTSTRAP_TEST_MODE is forbidden when running as root");
}
function testHook(name: string): string | undefined {
  return BOOTSTRAP_TEST_MODE ? process.env[name] : undefined;
}

/**
 * Escapes a string for literal use inside a RegExp.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Recovery for debris left by a *previous* bootstrap attempt on this exact
 * target that was interrupted in a way this process could never catch —
 * SIGKILL or a machine reboot before the atomic link() publish, or any
 * earlier failure whose own cleanup never ran. Only ever removes files
 * matching this target's own randomly-named temp pattern
 * (`.bootstrap-<32 hex chars>-<this target's basename>`, plus its
 * -wal/-shm sidecars) in the target's own directory — never touches
 * anything else. Safe to run unconditionally at the start of a new attempt
 * because the caller (rollout-bootstrap.sh) holds the same exclusive
 * rollout lock for the whole invocation, so no other legitimate process can
 * be concurrently using a leftover temp name for this target. Fails closed
 * (throws) if a matched file can't actually be removed — silently ignoring
 * a removal failure here could mask a real permissions/filesystem problem
 * rather than genuine stale debris.
 */
function cleanupStaleTempFiles(dir: string, path: string): void {
  const pattern = new RegExp(`^\\.bootstrap-[0-9a-f]{32}-${escapeRegExp(basename(path))}(-wal|-shm)?$`);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!pattern.test(entry)) continue;
    const full = join(dir, entry);
    try {
      rmSync(full);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error(`failed to remove stale bootstrap temp file ${full}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * Recovery specifically for the post-commit interruption window: link()
 * succeeded (the destination now exists and is fully valid — it's a hard
 * link to the same already-validated inode as the temp file) but unlink()
 * of the temp name never ran, because the process was SIGKILLed or the
 * machine rebooted in the narrow gap between the two. Unlike
 * cleanupStaleTempFiles(), this runs even when the destination already
 * exists — the whole point is recovering debris left *after* a successful
 * publish. Only removes a stale temp entry that is provably the *same
 * inode* as the current destination (same device + inode number, verified
 * via stat, not just a name match) — a name match with a *different* inode
 * would mean something unexpected is going on (not ordinary leftover
 * debris), so that case fails closed rather than being silently deleted.
 */
/**
 * Recovers debris from a previous bootstrap's post-commit interruption
 * window, grouped by stem and strictly two-phase: nothing is deleted until
 * *every* matching stem's main temp file (if present) has been validated.
 * Directory iteration order is unspecified, so a single combined pass that
 * deletes a sidecar as soon as it's seen — before a *later*-iterated main
 * file for that same stem turns out to be inode-mismatched — could delete
 * part of an unexpected state before the mismatch is even discovered.
 * Phase 1 only groups entries; phase 2 validates every stem's main file
 * (throwing before anything is removed if any stem fails validation);
 * phase 3 is the only place anything is actually unlinked, and only runs
 * once every stem has passed phase 2 cleanly. A sidecar is only ever
 * queued for removal once its own stem's main file is confirmed either
 * absent or the exact same inode as the destination.
 */
function cleanupStalePostCommitLink(dir: string, path: string): void {
  let destinationStat;
  try {
    destinationStat = lstatSync(path);
  } catch {
    return; // destination doesn't exist — nothing to reconcile here
  }
  if (!destinationStat.isFile()) return;
  const base = escapeRegExp(basename(path));
  // Captures the shared stem (group 1) plus an optional -wal/-shm suffix
  // (group 2) so every entry tied to the same temp attempt groups together
  // regardless of which one directory listing happens to return first.
  const stemPattern = new RegExp(`^(\\.bootstrap-[0-9a-f]{32}-${base})(-wal|-shm)?$`);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  // Phase 1: group by stem. No filesystem mutation yet.
  const stems = new Map<string, { hasMain: boolean; sidecars: string[] }>();
  for (const entry of entries) {
    const match = stemPattern.exec(entry);
    if (!match) continue;
    const stem = match[1];
    const suffix = match[2];
    const info = stems.get(stem) ?? { hasMain: false, sidecars: [] };
    if (suffix) info.sidecars.push(entry);
    else info.hasMain = true;
    stems.set(stem, info);
  }

  // Phase 2: validate every stem's main file before queuing *anything* —
  // including that stem's own sidecars — for removal. Throws immediately,
  // before phase 3 ever runs, if any stem's main file is inode-mismatched.
  const toRemove: string[] = [];
  for (const [stem, info] of stems) {
    let mainStat: ReturnType<typeof lstatSync> | undefined;
    if (info.hasMain) {
      const full = join(dir, stem);
      try {
        mainStat = lstatSync(full);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new Error(`failed to inspect stale post-commit temp file ${full}: ${err instanceof Error ? err.message : String(err)}`);
        }
        // Vanished between listing and stat — nothing to validate; falls
        // through to "absent", so this stem's sidecars are still safe.
      }
      if (mainStat) {
        if (mainStat.dev !== destinationStat.dev || mainStat.ino !== destinationStat.ino) {
          throw new Error(
            `stale temp file ${full} shares a name with the published database at ${path} but not its inode — refusing to remove it or its sidecars automatically; this needs manual operator review`,
          );
        }
        toRemove.push(full);
      }
    }
    for (const sidecar of info.sidecars) toRemove.push(join(dir, sidecar));
  }

  // Phase 3: every stem passed validation — now it's safe to actually remove.
  for (const full of toRemove) {
    try {
      rmSync(full);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error(`failed to remove stale post-commit temp file ${full}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * Attempts the no-replace half of publication: `link()` fails atomically
 * with EEXIST if anything now occupies `path`, including something that
 * appeared concurrently after every earlier check ran — unlike `rename()`,
 * which would silently replace it. Deliberately does *not* also unlink the
 * temp name — the caller controls that separately so it can record the
 * commit point (link succeeded, `path` now exists) before the final,
 * genuinely-uninterruptible unlink step.
 */
function publishLink(tempPath: string, path: string): void {
  try {
    linkSync(tempPath, path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`destination appeared concurrently during publication, refusing to overwrite: ${path}`);
    }
    throw err;
  }
}

/** A genuine, unconditional event-loop yield — allows a pending signal to actually be serviced at this point. A real production checkpoint, not a test-only mechanism. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Test-only pause, gated behind AGENT_BRIDGE_BOOTSTRAP_TEST_MODE, that
 * *extends* one of the real, unconditional production checkpoints
 * identified by `checkpoint` so a test can deterministically observe the
 * mid-flight state and inject a signal there. It does not introduce any
 * yield point that isn't already present in the unconditional production
 * path — "post-commit" is the one exception (between link() and unlink(),
 * proving the committed-state handler branch without requiring a genuinely
 * unobservable SIGKILL race), and is only ever awaited when this specific
 * hook is active, never in production (see bootstrapDatabase). "post-unlink",
 * "post-inspection", and "post-evidence" each extend one of the three real
 * checkpoints spanning the post-publication work — inspection, evidence-file
 * writing, and the final guard-teardown point — all still inside
 * withSignalCleanup()'s guarded region.
 */
async function testPause(checkpoint: "post-migration" | "post-validation" | "post-commit" | "post-unlink" | "post-inspection" | "post-evidence"): Promise<void> {
  const pauseFile = testHook("AGENT_BRIDGE_BOOTSTRAP_TEST_PAUSE_FILE");
  if (!pauseFile || testHook("AGENT_BRIDGE_BOOTSTRAP_TEST_PAUSE_AT") !== checkpoint) return;
  writeFileSync(pauseFile, "paused\n");
  const resumeFile = `${pauseFile}.resume`;
  const deadline = Date.now() + 5000;
  while (!existsSync(resumeFile) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

interface BootstrapSignalState {
  tempPath: string;
  /** Set true the moment link() succeeds — path now exists and is valid. */
  committed: boolean;
}

/**
 * Registers process-level cleanup for a graceful termination signal
 * (SIGTERM/SIGINT) received mid-bootstrap. This can only ever help for
 * *graceful* termination at an actual event-loop yield point — SIGKILL and
 * a machine power loss are, by definition, unobservable by any process and
 * cannot be handled here at all, and neither can a signal arriving during
 * the tight, deliberately-not-yielded link()+unlink() commit tail; recovery
 * from those specific cases is `cleanupStalePostCommitLink()`'s /
 * `cleanupStaleTempFiles()`'s job on the *next* invocation, not this one's.
 *
 * Reports two structurally different outcomes so a signal can never
 * produce an ambiguous result: if `state.committed` is already true (link()
 * succeeded — the database is genuinely, validly published), the message
 * says so explicitly and warns against retrying; otherwise it reports that
 * nothing was created. Removes its own listeners before exiting so the
 * process actually terminates with the expected semantics rather than
 * hanging or exiting 0.
 */
const SIGNAL_EXIT_CODES: Record<string, number> = { SIGINT: 130, SIGTERM: 143 };

async function withSignalCleanup<T>(state: BootstrapSignalState, fn: () => Promise<T>): Promise<T> {
  const handler = (signal: NodeJS.Signals) => {
    if (state.committed) {
      // The destination already exists and is fully valid — only the
      // redundant temp hard link name (and, if migration ever produced
      // them, its -wal/-shm sidecars) is left. Best-effort removal here;
      // cleanupStalePostCommitLink() recovers whatever is left on the next
      // invocation regardless, so a failure here isn't fatal to correctness.
      try { rmSync(state.tempPath, { force: true }); } catch { /* best-effort */ }
      removeSidecars(state.tempPath);
      process.stderr.write(
        `rollout-db: bootstrap interrupted by ${signal} AFTER the database was already published at the destination — ` +
        "the database exists and is valid; do NOT retry bootstrap for this target. Only a redundant temp hard link name was involved.\n",
      );
      process.exit(SIGNAL_EXIT_CODES[signal] ?? 1);
      return;
    }
    try {
      rmSync(state.tempPath, { force: true });
      removeSidecars(state.tempPath);
      process.stderr.write(`rollout-db: bootstrap interrupted by ${signal} before publication — no database was created, temp state cleaned up\n`);
    } catch (err) {
      process.stderr.write(
        `rollout-db: bootstrap interrupted by ${signal} before publication, but cleanup of ${state.tempPath} itself failed: ` +
        `${err instanceof Error ? err.message : String(err)} — cleanupStaleTempFiles() will recover it on the next attempt\n`,
      );
    }
    process.exit(SIGNAL_EXIT_CODES[signal] ?? 1);
  };
  process.on("SIGTERM", handler);
  process.on("SIGINT", handler);
  try {
    return await fn();
  } finally {
    process.off("SIGTERM", handler);
    process.off("SIGINT", handler);
  }
}

/**
 * Bootstrap a single genuinely-missing database (Phase 4C.3, issue #135):
 * reuses openDb()'s existing missing-file path unchanged — it already
 * creates the file and runs it through migration 1's real DDL, the same
 * registered plan every other database goes through, so there is no
 * duplicated or shortcut schema definition here.
 *
 * Atomicity is layered on top of that unchanged path, not inside it: the
 * new database is created and migrated at a randomly-named temp path in the
 * *same* directory as the final target, validated (integrity, foreign keys,
 * exact schema version), then published with no-replace link()+unlink()
 * semantics only after every check passes. Five real, unconditional
 * event-loop yields — after migration, after validation, after unlink(),
 * after the post-publication inspection read, and after the evidence file
 * is written — all always present in production, not just under a test
 * hook, let a pending SIGTERM/SIGINT actually be serviced. All three
 * post-commit checkpoints stay inside withSignalCleanup()'s guarded
 * region, so the committed-state handler remains installed through every
 * fallible step of the post-publication work, right up to the last thing
 * this function does. Only the link()+unlink() pair itself is deliberately
 * *not* interrupted by any yield, so it stays the minimal possible
 * synchronous window. If anything
 * fails before that window — missing-file precondition, parent validation,
 * the migration itself, post-migration validation, publication racing a
 * concurrently-created destination, or a serviced signal — the temp file
 * (and any -wal/-shm sidecars) is removed and the final path is left
 * completely untouched. SIGKILL or a machine reboot inside the
 * link()+unlink() window itself cannot be observed or handled by any
 * process at all — that narrow window can leave a harmless extra hard link
 * (same inode, same already-validated content as the published database,
 * never a partial/corrupt file) at the stale temp name, and possibly an
 * orphaned -wal/-shm sidecar alongside or instead of it;
 * `cleanupStalePostCommitLink()` recovers both opportunistically on the next
 * bootstrap attempt against the same target, under the same exclusive
 * rollout lock, even though the destination already exists by then.
 */
async function bootstrapDatabase(path: string, role: string, evidencePath: string | null): Promise<DbEvidence> {
  const dir = dirname(path);
  validateParentDir(dir);
  // Runs even when the destination already exists — recovers a stale
  // extra hard link left by a SIGKILL/reboot between a *previous*
  // attempt's link() and unlink(), verified by inode, not name alone. Must
  // run before the occupied-check below, and under the shared rollout
  // lock the shell wrapper holds for the whole invocation.
  cleanupStalePostCommitLink(dir, path);
  if (pathOccupied(path)) throw new Error(`database already exists, use migrate instead: ${path}`);
  cleanupStaleTempFiles(dir, path);
  const tempPath = join(dir, `.bootstrap-${randomBytes(16).toString("hex")}-${basename(path)}`);
  const state: BootstrapSignalState = { tempPath, committed: false };
  const cleanupTemp = () => {
    try { rmSync(tempPath, { force: true }); } catch { /* best-effort */ }
    removeSidecars(tempPath);
  };
  try {
    return await withSignalCleanup(state, async () => {
      if (testHook("AGENT_BRIDGE_BOOTSTRAP_TEST_FORCE_MIGRATION_FAILURE") === path) {
        // Pre-creates a file at the exact temp path with a future,
        // unsupported schema version, so openDb()'s own existing
        // version-gate rejects it — a real migration-time failure, not a
        // simulated one.
        const raw = new Database(tempPath);
        raw.exec("PRAGMA user_version = 99;");
        raw.close();
      }
      openDb(tempPath, { serviceId: `rollout:bootstrap:${role}` }).close();
      const installationId = process.env.AGENT_BRIDGE_INSTALLATION_ID?.trim()
        || `install-${randomBytes(16).toString("hex")}`;
      const createdAt = new Date().toISOString();
      const metadata = new Database(tempPath);
      metadata.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(
        "agent_bridge_installation_id", installationId,
      );
      metadata.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(
        "agent_bridge_database_provenance",
        JSON.stringify({ schemaVersion: 1, source: "fresh-install", role, path, installationId, createdAt }),
      );
      metadata.close();

      // Real production checkpoint 1: unconditional, always present.
      await yieldToEventLoop();
      await testPause("post-migration");

      if (testHook("AGENT_BRIDGE_BOOTSTRAP_TEST_FORCE_INVALID_SCHEMA") === path) {
        const raw = new Database(tempPath);
        raw.exec("PRAGMA user_version = 4242;");
        raw.close();
      }
      validateBootstrapped(tempPath);

      // Real production checkpoint 2: unconditional, always present. Only
      // the minimal link()+unlink() commit tail below is not interrupted.
      await yieldToEventLoop();
      await testPause("post-validation");

      if (testHook("AGENT_BRIDGE_BOOTSTRAP_TEST_PRE_PUBLISH_OCCUPY") === path) {
        writeFileSync(path, "concurrently created by a different process\n");
      }
      publishLink(tempPath, path);
      state.committed = true;
      // "post-commit" is test-only and never awaits in production — see
      // testPause()'s doc comment. It exists solely so a test can prove the
      // committed-state signal-handler branch above (never "nothing
      // happened") without requiring a genuinely unobservable SIGKILL race.
      await testPause("post-commit");
      unlinkSync(tempPath);

      // Real production checkpoint 3: unconditional, always present, and
      // still inside withSignalCleanup()'s guarded region — the
      // committed-state signal handler stays installed through the
      // post-publication evidence read below, so a signal here also
      // reports "already published," never an ambiguous result.
      await yieldToEventLoop();
      await testPause("post-unlink");

      removeSidecars(tempPath);
      const evidence = { ...inspectDatabase(path, true), role };
      const provenancePath = `${path}.provenance.json`;
      const provenanceTemp = `${provenancePath}.tmp-${randomBytes(8).toString("hex")}`;
      writeFileSync(provenanceTemp, `${JSON.stringify({
        schemaVersion: 1,
        source: "fresh-install",
        role,
        path,
        installationId,
        createdAt,
        databaseSha256: evidence.sha256,
      })}\n`, { mode: 0o600 });
      renameSync(provenanceTemp, provenancePath);

      // Real production checkpoint 4: unconditional, always present, after
      // the (synchronous, but now-complete) inspection read and before the
      // evidence file is written — still guarded, same reasoning as
      // checkpoint 3.
      await yieldToEventLoop();
      await testPause("post-inspection");

      writeEvidence(evidencePath, "bootstrap", [evidence]);

      // Real production checkpoint 5: unconditional, always present — the
      // final yield before the guard is removed, so a signal arriving
      // immediately after the evidence file is written is still reported
      // as "already published," not silently missed the instant this
      // callback resolves and withSignalCleanup() tears down its listeners.
      await yieldToEventLoop();
      await testPause("post-evidence");

      return evidence;
    });
  } catch (err) {
    cleanupTemp();
    if (state.committed) {
      throw new Error(
        `bootstrap published ${path} successfully but failed during post-publication work (${tempPath}): ` +
        `${err instanceof Error ? err.message : String(err)} — do not retry bootstrap for this target, the database exists and is valid`,
      );
    }
    throw err;
  }
}

function writeEvidence(path: string | null, mode: Mode, databases: DbEvidence[]): void {
  if (!path) return;
  const content = `${JSON.stringify({ mode, createdAt: new Date().toISOString(), databases }, null, 2)}\n`;
  if (path === "-") {
    process.stdout.write(content);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { mode: 0o600 });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "bootstrap") {
    const options = parseBootstrapArgs(argv.slice(1));
    // writeEvidence() runs *inside* bootstrapDatabase(), still within
    // withSignalCleanup()'s guarded region — see its checkpoint 4/5 comments.
    await bootstrapDatabase(options.path, options.role, options.evidencePath);
    return;
  }
  if (argv[0] === "verify-provenance") {
    const options = parseProvenanceCheckArgs(argv.slice(1));
    const db = openProductionDb(options.path, {
      serviceId: `rollout:verify-provenance:${options.role}`,
      installationId: options.installationId,
      requireInstallationIdentity: true,
      databaseRole: options.role,
    });
    db.close();
    return;
  }
  const options = parseArgs(argv);
  const unitsFor = (path: string) => options.resolvingUnits.get(path) ?? [];
  if (options.mode === "inspect") {
    const evidence = options.databases.map((path) => inspectDatabase(path, false, unitsFor(path)));
    const legacyQueues = evidence.reduce((sum, database) => sum + database.legacyQueueCount, 0);
    if (legacyQueues !== 0) throw new Error(`legacy queue count is nonzero: ${legacyQueues}`);
    writeEvidence(options.evidencePath, options.mode, evidence);
    return;
  }
  if (options.mode === "checkpoint") {
    const evidence = options.databases.map((path) => checkpointDatabase(path, unitsFor(path)));
    writeEvidence(options.evidencePath, options.mode, evidence);
    return;
  }
  if (options.mode === "migrate") {
    // Test-only synchronization point (Phase 4C.5, issue #135): lets a UAT
    // test deterministically prove a SIGKILL landed mid-cohort — after at
    // least one role has migrated, before the rest have — instead of
    // guessing from timing. Only ever active when both an explicit barrier
    // file path is supplied AND the process is not running as root (the
    // same "never under a real production invocation" gate the shell
    // helpers' test-only env seams use); a real operator invocation never
    // sets this variable, so this is a no-op path in production.
    const barrierFile = process.env.AGENT_BRIDGE_ROLLOUT_TEST_MIGRATE_BARRIER_FILE;
    const pauseAfterIndex = process.env.AGENT_BRIDGE_ROLLOUT_TEST_MIGRATE_PAUSE_AFTER_INDEX;
    const testHooksAllowed = Boolean(barrierFile) && process.getuid?.() !== 0;
    let migratedCount = 0;
    for (const path of options.databases) {
      openDb(path, { serviceId: "rollout:migration" }).close();
      migratedCount += 1;
      if (testHooksAllowed) {
        writeFileSync(barrierFile!, String(migratedCount));
        if (pauseAfterIndex && migratedCount === Number(pauseAfterIndex)) {
          const resumeFile = `${barrierFile}.resume`;
          while (!existsSync(resumeFile)) {
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        }
      }
    }
    writeEvidence(options.evidencePath, options.mode, options.databases.map((path) => inspectDatabase(path, true, unitsFor(path))));
    return;
  }
  const evidence = options.databases.map((path) => inspectDatabase(path, true, unitsFor(path)));
  const legacyQueues = evidence.reduce((sum, database) => sum + database.legacyQueueCount, 0);
  if (legacyQueues !== 0) throw new Error(`legacy queue count is nonzero after migration: ${legacyQueues}`);
  writeEvidence(options.evidencePath, options.mode, evidence);
}

main().catch((error) => {
  process.stderr.write(`rollout-db: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
