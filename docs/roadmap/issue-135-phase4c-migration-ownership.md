# Issue #135 Phase 4C — Production Migration Ownership and Gating

Status: **Phase 4C complete, including the Phase 4C.7 production deployment.** This document retains design history and records the implemented guarded-rollout contract. The current helper additionally accepts a cohort whose services are already quiesced, proves containment again, drains SQLite WALs offline before backup, performs the post-stop database inspection, and clears only zero-byte sidecars after checkpointing. References below that say `assert_service_active` blocks every re-invocation describe the earlier design and are superseded by that implemented flow; the interrupted sentinel and explicit operator review requirements remain in force.

## 0. Why this exists

PR #147 established `CURRENT_SCHEMA_VERSION` and a transactional migration boundary, but deliberately left production migration *ownership* undefined: `openDb()` — called identically by every ordinary service entrypoint and by `scripts/rollout-db.ts`'s `migrate` mode — auto-migrates a legacy (`user_version = 0`) database on open. That means today, an ordinary service restart against a stale-schema database would silently migrate it outside the guarded rollout helper's containment, backup, and evidence machinery. This document defines the contract that closes that gap.

## 1. Locked decisions

These are settled; the rest of this document designs around them, not toward alternatives.

1. **Ordinary production startup:**
   - **current** schema → starts normally.
   - **legacy** schema → fails closed with a "migration required" error. It does **not** auto-migrate.
   - **future** schema → fails closed before WAL mode or any write (already true as of PR #147; reaffirmed here as permanent policy, not just current code behavior).
2. **The guarded rollout helper (`scripts/rollout-agent-bridge.sh` + `scripts/rollout-db.ts`) is the sole production migration owner.** No other code path — not ordinary `openDb()`, not a service's own startup logic — may advance a production database's schema version.
3. **No live/in-place downgrade or down migrations.** There is no code path that reduces `user_version` or reverses a migration's DDL on a running database.
4. **Rollback after a committed migration means restoring the complete pre-migration database cohort and previous binary/configuration** — not a schema-level down-migration. This matches the rollout helper's existing backup/restore model exactly; it is not a new mechanism.
5. **All database-consuming services must be stopped before migration, with no restart until every database reaches and validates the exact target version.** Partial restart (some services back up on the new schema while others are still stopped) is not a supported intermediate state.
6. **Shared database paths must be canonicalised and migrated once.** Multiple units resolving to the same file (see §3) must be deduplicated before any backup or migration step; each canonical file is touched exactly once per rollout.
7. **Any migration or validation failure restores the whole cohort.** Partial success — some of the five databases migrated and validated, others not — is not an acceptable end state; either all five reach and validate the target version, or all five are restored to their pre-migration state.
8. **Interrupted rollouts remain explicitly incomplete.** A rollout that stops mid-sequence (process killed, machine rebooted, operator Ctrl-C) must not silently resume as either the old or the new release. It must require explicit operator re-invocation, and the containment/precondition checks must re-verify from scratch rather than trusting an interrupted run's partial state.
9. **Fresh/missing-database bootstrap is a distinct, explicitly owned path — not a variant of "legacy."** A database that doesn't exist yet (first install, or a genuinely new role added later) is not "behind schema," it's absent. Bootstrap creation is the responsibility of the guarded rollout helper's install/first-run path (§6.5), never an implicit side effect of an ordinary `openDb()` call.
10. **`openDb()` itself is not the strict gate.** It stays the general-purpose, backward-compatible opener — dozens of existing tests (`test/db.test.ts` alone has 15+ call sites) rely on it creating a brand-new file-backed database on a missing path as everyday setup, not as legacy-fixture migration testing specifically. Redefining `openDb()` to require an existing file would be a breaking public-API change with no compatibility path, not a narrowing. The strict fail-closed contract in §2 belongs to a **new, additive** entry point used only by the five ordinary-startup service entrypoints (§6.1) — `openDb()`'s existing behavior and every test that depends on it are unchanged.

## 2. Startup behaviour matrix

Applies to a **new, additive** strict opener — provisionally `openProductionDb()`, exported alongside `openDb()` from `src/db.ts` — used only by the five ordinary-startup entrypoints (`src/index.ts`, `src/index-worker.ts`, `src/index-interactive.ts`, `src/index-discord-interactive.ts`, `src/index-health.ts`). **`openDb()` itself does not change** (locked decision 10) — it keeps its current create-if-missing, auto-migrate behavior exactly as today, because dozens of existing tests depend on that as ordinary setup, not as a legacy-migration-specific path. `openProductionDb()` shares `openDb()`'s internal WAL/FK-pragma/`BridgeDb`-construction tail (extracted into a private helper both call, to avoid duplicating that logic) but replaces the file-open mode and version gate:

| Schema state (`user_version`) | `openDb()` (unchanged) | `openProductionDb()` (new) |
|---|---|---|
| `current` (`== CURRENT_SCHEMA_VERSION`) | Starts normally | Starts normally |
| `legacy` (`0`, file exists) | Auto-migrates transactionally, then starts | **Fails closed** before WAL mode or any write, with `MigrationRequiredError` identifying the required rollout action. Does not migrate. |
| `migratable` (`0 < user_version < CURRENT_SCHEMA_VERSION`, once multi-step migrations exist) | Auto-migrates | Fails closed with `MigrationRequiredError`, same as legacy |
| `future` (`> CURRENT_SCHEMA_VERSION`) | Fails closed before WAL, connection closed, `UnsupportedSchemaVersionError` | Same — this is already correct in `openDb()` today and `openProductionDb()` inherits it unchanged |
| Negative / non-integer | Fails closed before WAL (per PR #147 round-2 review fix) | Same |
| **Missing file** | Creates the file (`new Database(dbPath)`'s default mode), applies the complete registered migration plan, and ends at `CURRENT_SCHEMA_VERSION` — this is already correct and already tested (`dbSchema.test.ts`'s "keeps a fresh database at the current version" case) and is the mechanism bootstrap reuses (§3) | `{ fileMustExist: true }` — fails closed with a distinct `DatabaseMissingError`. No directory or file is created by production service startup, ever. |

## 3. Rollout-time behaviour matrix

Applies to `scripts/rollout-db.ts`'s `inspect` / `migrate` / `validate` modes, invoked only from `scripts/rollout-agent-bridge.sh` after containment is proven (guarded rollout helper phase 4 in `docs/GUARDED-ROLLOUT.md`).

| Mode | Current behaviour | Required behaviour |
|---|---|---|
| `inspect` | Read-only schema/integrity/queue evidence per database; `fileMustExist: true`; aborts if any legacy queue count is nonzero | Unchanged, plus: cross-check that the resolved database set, once canonicalised (§4), matches the expected five-role inventory exactly — extra or missing canonical paths abort before backup |
| `migrate` | Calls `openDb(path, ...)` directly per database in a plain loop — a mid-loop failure propagates immediately and does not attempt the remaining databases (already fail-fast; verified by reading the loop, no per-database try/catch) | **Unchanged — keeps calling `openDb()`.** This is exactly the auto-migrating behavior the guarded rollout helper is supposed to own; nothing here was ever the problem. Same fail-fast, no-partial-continuation, transactional/FK-check guarantees as today. |
| `validate` | Re-inspects each database and requires `schema === "current"` | Unchanged |
| **First-run bootstrap** (new mode) | Not supported — `rollout-agent-bridge.sh` requires every discovered database to already exist (`[[ -f "$discovered" ]] || die ...`) before acquiring the lock, and `rollout-db.ts inspect`/`migrate`/`validate` all open with `fileMustExist: true` | **New, explicitly separate `bootstrap` mode.** Reuses `openDb()`'s existing missing-file path unchanged — it already creates the file and runs it through migration 1's real DDL (`applyLegacyCompatibleBaseline`/`applyMigrations`), the same registered plan every other database goes through, so there is no duplicated or shortcut schema definition. What's new is entirely at the rollout-helper level, not the database layer: a root-owned, separately-invoked route (not folded into the ordinary `--expected-commit` migrate flow) with its own allowlist of expected new-role paths, parent-directory/ownership validation matching the existing backup-directory discipline, atomic creation (write to a temp path, then atomic rename into place, mirroring `rollout-restore.py`'s existing descriptor-relative approach), and cleanup of the partial file if `openDb()`'s migration fails partway. Never invoked implicitly by `inspect`/`migrate`/`validate`, and never bundled into the same invocation as a migration of *existing* databases — no pre-migration backup exists for a database that didn't exist, so it cannot participate in the whole-cohort restore guarantee (locked decision 7) the same way. Requires explicit operator confirmation that the missing file is expected (new role), not a symptom of misconfiguration or accidental deletion. |

## 4. Five-database-role inventory and shared-path handling

Current production topology (`systemd/agent-bridge-rollout.conf.example`), seven units resolving to five canonical databases:

| Unit(s) | Resolved `DB_PATH` / `HEALTH_DB_PATH` | Canonical database |
|---|---|---|
| `agent-bridge-antigravity.service`, `agent-bridge-claude.service`, `agent-bridge-codex.service` | `/home/content-crawler/agent-bridge/.data/bridge.sqlite` (shared — see note) | **shared** |
| `agent-bridge-discord-interactive.service` | `/home/content-crawler/agent-bridge/.data/discord-interactive.sqlite` | **discord** |
| `agent-bridge-health.service` | `/home/content-crawler/runtime/agent-bridge/health/health.sqlite` | **health** |
| `agent-bridge-interactive.service` | `/home/content-crawler/runtime/agent-bridge/interactive/bridge.sqlite` | **interactive** |
| `agent-bridge-worker-bot.service` | `/home/content-crawler/runtime/agent-bridge/worker/bridge.sqlite` | **worker** |

**Note on the shared role:** the per-CLI-kind `.env.<kind>.example` files (`.env.antigravity.example`, `.env.claude.example`, `.env.codex.example`) show *different* default `DB_PATH` values per kind (`.data-antigravity/`, `.data-claude/`, `.data-codex/`) — these are development defaults. The production `rollout.conf` example coalesces all three onto one canonical `bridge.sqlite`. This divergence between documented per-kind defaults and actual shared production configuration is exactly the hazard locked decision 6 exists to guard against: canonicalisation must be done by resolving each unit's *actual effective* `DB_PATH` (already implemented — see `docs/GUARDED-ROLLOUT.md` §"Resolve each selected unit's effective `DB_PATH`") and deduplicating by resolved real path (`realpath`, not string equality) before any backup or migration step touches a file twice.

**Requirement:** `rollout-db.ts inspect` evidence must record, per canonical database, the full list of units that resolve to it, so a review of rollout evidence can confirm the five-role → seven-unit mapping matches expectation and no unit is silently pointing at an unexpected file.

## 5. Ownership boundaries

| Concern | Owner | Not owned by |
|---|---|---|
| Schema version validation on ordinary (production) startup | `openProductionDb()` (new, §6.1) — the five service entrypoints import only this, never `openDb()` directly | Individual service entrypoints — they must not duplicate version-checking logic |
| `openDb`/`applyMigrations`/`applyMigrationsUpTo`/`applyLegacyCompatibleBaseline` import/call anywhere under production `src/` | **Nothing** — prohibited by default, deny-by-default arch-lint rule covering the whole migration-primitive set (§6.6), not just `openDb` and not a five-file allowlist | Every `src/` file except `src/db.ts`, `src/db/schema.ts`, and `src/db/legacyBaselineMigration.ts` — including any future module, not just the five entrypoints known today |
| General-purpose database open (tests, dev, and the rollout helper's own migration) | `src/db.ts` `openDb()` — unchanged (locked decision 10); freely usable from `test/*.ts` and `scripts/rollout-db.ts`, both outside the `src/` rule above | — |
| Schema migration execution | `scripts/rollout-db.ts` `migrate` mode, calling the unchanged `openDb()`, invoked only by `scripts/rollout-agent-bridge.sh` | Ordinary service entrypoints, which use `openProductionDb()` and never migrate; every other `src/` module (enforced by the deny-by-default rule above) |
| First-run database bootstrap | `scripts/rollout-db.ts` `bootstrap` mode (new — §2, §3), reusing `openDb()`'s existing missing-file path, never invoked implicitly | `openProductionDb()` under ordinary startup (must `fileMustExist`, never create); `migrate`/`inspect`/`validate` modes |
| Containment (stop, prove dead) | `scripts/rollout-agent-bridge.sh` phase 4 (existing, unchanged) | — |
| Backup | `scripts/rollout-agent-bridge.sh` phase 6 (existing, unchanged) | — |
| Restore | `scripts/rollout-restore.py`, invoked by `rollout-agent-bridge.sh` (existing, unchanged) | — |
| Legacy DDL / historical repair logic | `src/db/legacyBaselineMigration.ts` (migration 1, unchanged from PR #147) | — |
| Advisor / conversation-turn persistence | `AdvisorRepository` / `ConversationRepository` (PR #154, unchanged) | — |
| `pending_messages` queue persistence | `BridgeDb` + `LockRepository` (final boundary, Issue #135 decision comment 2026-07-18) | — |
| Exact-version rollout gate | `rollout-db.ts` `validate` mode (existing `requireCurrent` check, unchanged) | — |
| Deployment approval | Explicit separate human authorization, every time (existing project convention throughout this issue's history) | Any automated process |

## 6. Proposed rollout-helper changes

Minimal, additive — no removal of existing containment/backup/evidence machinery, and **`openDb()` itself is untouched** (locked decision 10).

1. **`src/db.ts`: add `openProductionDb()`, leave `openDb()` alone.**
   `openDb()` keeps its exact current signature and behavior — create-if-missing, auto-migrate on legacy, everything the ~15+ existing `test/db.test.ts` call sites (and more elsewhere) already depend on. A new, additive export `openProductionDb()` shares `openDb()`'s internal WAL-pragma/FK-pragma/non-schema-maintenance/`BridgeDb`-construction tail — extracted into a private helper both functions call, so that shared logic isn't duplicated — but opens with better-sqlite3's `{ fileMustExist: true }` (missing file → `DatabaseMissingError`, no directory or file created) and a strict version gate: anything that is not exactly `CURRENT_SCHEMA_VERSION` fails closed before WAL mode or any write, with `MigrationRequiredError` for legacy/migratable (distinct from `UnsupportedSchemaVersionError` for future/negative/non-integer, so operators and logs can tell "you're behind" from "you're ahead/corrupt" at a glance).

   This is purely additive: no existing `openDb()` caller changes, no test needs to move. The five ordinary-startup entrypoints switch their one `openDb(...)` call each to `openProductionDb(...)`.

2. **`rollout-db.ts`: no change to `migrate` mode.** It keeps calling `openDb()` exactly as today — that auto-migrating behavior was never the problem; the problem was ordinary services also being able to reach it. No change to its existing fail-fast behavior either (confirmed by reading the current implementation: a plain loop over databases with no per-database try/catch, so a failure on database N already stops before attempting N+1).

3. **`rollout-db.ts inspect`: add per-database "resolving units" evidence field** (§4), sourced from the same unit/env resolution `rollout-agent-bridge.sh` already performs — pass the resolved unit→path mapping into `rollout-db.ts` as evidence input rather than re-deriving it.

4. **`rollout-agent-bridge.sh`: add an explicit interrupted-rollout guard (locked decision 8), with one unambiguous sentinel-lifecycle contract, a fully specified storage format, and a guarded clearing operation.**

   **Storage.** The sentinel is a single fixed, root-owned path beneath the already-validated canonical `log_dir` (which `docs/GUARDED-ROLLOUT.md` already requires to exist as a canonical, root-owned directory with no group/world write bits — the sentinel reuses that existing validation rather than introducing a new directory), e.g. `$log_dir/.rollout-in-progress`. It is:
   - A **regular file**, never a symlink — checked the same way every other file operation in this script already validates its targets (open with `O_NOFOLLOW`-equivalent semantics; refuse if `lstat` shows a symlink).
   - **Mode 0600, owned by the root user the helper runs as** — checked before trusting its contents, exactly like the existing config-file ownership check (`docs/GUARDED-ROLLOUT.md` §Installation already requires the config to stay `root:root`, not group/world writable — same standard applies here).
   - Written **atomically** (temp file in the same directory, then rename into place — the same pattern already used for `$log_dir/latest`), containing structured, human- and script-readable evidence: the `expected_commit` this rollout is for, the `artifact_dir` where its evidence lives, a timestamp, and the invoking process's identity (hostname/PID) — enough for an operator to look at the sentinel and immediately find the right evidence without guessing.

   **Lock-then-sentinel ordering** (avoids the check-then-act race in an earlier draft: a second invocation observing no sentinel, then acquiring the lock only after a third invocation had already failed and left one behind), all under the *existing* `flock --exclusive --nonblock` at the point already in the script (line ~192, before any precondition check runs):
   1. Acquire the exclusive `flock` (unchanged — the sole serialization point).
   2. Immediately after, inspect the sentinel path under that same lock — validating ownership/mode/non-symlink *before* trusting its contents. If a valid sentinel is present, abort with an instruction to review the prior run's evidence (using the `artifact_dir` recorded in the sentinel itself) before manually clearing it. If the sentinel exists but fails ownership/mode/symlink validation, treat that as its own containment-uncertain failure — never silently overwrite or ignore a sentinel that doesn't look like the ones this helper writes.
   3. Atomically create the new sentinel (`O_CREAT|O_EXCL`, refusing if one somehow already exists despite step 2) before any precondition check proceeds.

   **Clearing is a guarded operation, not a bare `rm`, and both paths acquire the same exclusive rollout lock — clearing never happens lockless.** It only ever happens two ways:
   (a) automatically, from within the *same invocation* that created the sentinel, inside the `on_exit` trap, gated by `sentinel_removable` (below) — never from a different process, and the invocation already holds the `flock` from step 1 above, straight through to exit;
   (b) manually, via a separate, explicitly reviewed operator tool that **acquires the same exclusive `flock` before reading or deleting anything** — using the identical `flock --exclusive --nonblock` acquisition the main script uses, so it cannot run concurrently with an active rollout. If the lock cannot be acquired (a rollout is genuinely in progress), the tool aborts immediately and **leaves the sentinel completely untouched** — it never falls back to an unguarded read or delete. Only once the lock is held does it re-read and revalidate the sentinel's ownership/mode/non-symlink status and cross-check its recorded `expected_commit`/`artifact_dir` against what the operator is actually reviewing (so a stale sentinel from an unrelated earlier attempt can't be mistaken for the current one), then logs the manual-clear action with the same evidence discipline as every other phase, then removes it and releases the lock.

   This means a manual clear attempt made while a rollout is actively running is structurally refused at the lock-acquisition step, not merely discouraged by convention — the same guarantee the main script's own precondition-sentinel check relies on.

   **Removal contract — one rule, not exit-code-dependent** (the script's overall exit status stays nonzero on every failure path, including a cleanly auto-restored one, so exit code alone can't signal "safe to retry"; a dedicated flag is required). The contract is gated on whether the *system is left in a state an ordinary re-invocation can actually proceed from* — not merely on whether database mutation occurred. Critically, `rollout-agent-bridge.sh`'s own precondition checks require every unit to already be **active** before it will attempt to stop them (`assert_service_active` runs in a loop before `stop_attempted` is ever set) — so a state where services have been stopped, even if the database was never touched, is **not** something a bare re-invocation can recover from; it needs its own explicit handling, not a "database wasn't touched, so it's fine" auto-clear.
   - **Remove** the sentinel when, and only when, the run reaches one of these *verified-safe* states — "verified-safe" means the outcome is fully known and requires no further ambiguity resolution, **not** that a bare re-invocation is always the next step: only case (b) below is actually re-invokable as-is; case (a) needs nothing further; case (c) still requires the documented `FAILED_RESTORED` recovery flow in §9:
     (a) `DONE` — full success;
     (b) failure strictly **before** `stop_attempted` is set (pure precondition failure — nothing was ever touched, containment was never even attempted, services are still active, so a bare re-invocation behaves identically to the first attempt);
     (c) **verified full restoration** — `restore_backups` returns success (not merely attempted) *and* every restored database's SHA-256 matches the backup manifest (services remain stopped here too, so this still isn't "just re-invoke" — see the `FAILED_RESTORED` recovery path in §9, which is why removability here means "safe to hand to the documented recovery flow," not "safe to blindly retry the same command").
     Introduce an explicit `sentinel_removable` flag set only in these three cases — never inferred from `$?`.
   - **Retain** the sentinel in every other case, **including** a failure at or after the primary stop attempt where containment is independently re-proven but the cohort backup did not complete and verify (a partial, unmanifested backup artifact may exist but must never be used for restore) — this is the new `STOPPED_UNCHANGED` state (§9), not an auto-clear, because services are down and `assert_service_active` blocks a bare retry. Also retained: process killed or machine rebooted mid-rollout (nothing runs to remove it); containment cannot be re-proven during the failure trap ("rollback skipped: stopped state could not be proven" — genuinely unknown whether services are actually down); `restore_backups` itself fails or returns partial/unverified success (`RESTORE_INCOMPLETE`, §9); and post-start failure (`STOPPED_PRESERVED` — services already running against the new schema, so an automatic DB rollback could race live writes; this always requires operator judgment, never an automatic retry).

5. **New `bootstrap` mode for genuinely missing databases (§2, §3).** Explicitly separate invocation from ordinary migration; never runs implicitly; reuses `openDb()`'s existing, already-tested missing-file→full-migration-plan path at the database layer, with new root-owned allowlist/ownership/atomic-creation/cleanup-on-failure machinery at the rollout-helper level (§3).

6. **Enforce sole migration ownership as a deny-by-default rule across production `src/`, covering every migration primitive — not just `openDb` and not a five-file allowlist.** An earlier draft of this section only prohibited `openDb` imports — but verified by reading `src/db/schema.ts` and `src/db/legacyBaselineMigration.ts` directly: `applyMigrations()` and `applyMigrationsUpTo()` are public exports of `schema.ts`, and `applyLegacyCompatibleBaseline()` is a public export of `legacyBaselineMigration.ts`. A future production module could open a raw `better-sqlite3` connection itself (bypassing `openDb`/`openProductionDb` entirely) and call `applyMigrations()` directly, migrating a production database without ever importing `openDb` — exactly the bypass locked decision 2 exists to close. The rule must cover the whole primitive set: `openDb`, `applyMigrations`, `applyMigrationsUpTo`, `applyLegacyCompatibleBaseline`. Exact, named exceptions — verified against the actual current internal wiring, not assumed:
   - `src/db.ts` — where `openDb()` is defined, and which imports `applyMigrations` from `./db/schema.js` to run it as part of `openDb()`/`openProductionDb()`'s shared construction path (confirmed: `src/db.ts` line 28 imports exactly `applyMigrations`, `CURRENT_SCHEMA_VERSION`, `UnsupportedSchemaVersionError` — not `applyMigrationsUpTo` or `applyLegacyCompatibleBaseline`, so those two stay prohibited even in `db.ts`).
   - `src/db/schema.ts` — where `applyMigrations`/`applyMigrationsUpTo` are defined, and which imports `applyLegacyCompatibleBaseline` from `./legacyBaselineMigration.js` (confirmed: `schema.ts` line 2).
   - `src/db/legacyBaselineMigration.ts` — where `applyLegacyCompatibleBaseline` is defined.
   - No other `src/` file, entrypoint or otherwise, is exempted for any of the four primitives.

   `scripts/rollout-db.ts` and every `test/*.ts` file are outside `src/` and outside this rule's scope entirely — they keep using all four primitives freely, as today (this is exactly how `dbSchema.test.ts` already exercises `applyMigrationsUpTo`/`applyLegacyCompatibleBaseline` directly). Regression coverage: (i) the five entrypoints importing `openProductionDb` pass; (ii) a fixture entrypoint importing `openDb` directly fails, as before; (iii) a fixture *non-entrypoint* `src/` module importing `openDb` directly also fails, proving the rule isn't scoped to just the five known files; (iv) **new** — a fixture `src/` module importing `applyMigrations`, `applyMigrationsUpTo`, or `applyLegacyCompatibleBaseline` directly (with no `openDb` import at all) also fails, proving the primitive-level bypass is closed, not just the `openDb`-shaped one.

7. **No change to:** containment proof, backup/restore mechanics, `--expected-commit` exact-SHA requirement, sudoers/config model, or the "legacy queue discard is unsupported" rule.

## 7. Failure and interruption semantics

`sentinel_removable` is the new explicit flag from §6.4 — set only in the three verified-safe cases below, never inferred from the script's overall exit code (which stays nonzero on every failure path, including a cleanly auto-restored one). "Verified-safe" means the outcome is fully known, **not** that a bare re-invocation is the next step in every case — only the pure-precondition-failure case actually is; `FAILED_RESTORED` still requires the documented §9 recovery flow, since services are stopped either way. Removability is deliberately **not** granted just because the database was untouched: `rollout-agent-bridge.sh` requires every unit to already be **active** before it will attempt to stop them, so any failure at or after the primary stop attempt leaves the system in a state a bare retry cannot recover from — even when containment is cleanly re-proven — which is exactly why that case is `STOPPED_UNCHANGED` (sentinel retained), not an auto-clear.

| Failure point | Current helper behavior | This policy | `sentinel_removable`? |
|---|---|---|---|
| Precondition failure, strictly before `stop_attempted` is set | Aborts, no rollback needed (nothing was ever touched, containment was never even attempted, services still active) | Unchanged | **Yes** — a bare re-invocation behaves identically to the first attempt |
| Failure at/after the primary stop attempt, but `on_exit`'s re-verification of containment **succeeds** (services proven stopped, even if the original stop command itself returned nonzero) and the cohort backup did not complete and verify (a partial, unmanifested backup artifact may exist but must never be used for restore) | New row (an earlier draft treated this as safely retryable) | Services are stopped, source databases remain on the OLD schema; offline WAL checkpointing may have incorporated committed pages into a main file — but `assert_service_active` will reject a bare re-invocation, so this is **not** equivalent to "nothing happened." New distinct state: `STOPPED_UNCHANGED` (§9). | **No** — sentinel retained; the state is fully known, but action (documented in §9) is still required before a retry can succeed |
| Failure at/after the primary stop attempt, where `on_exit`'s re-verification **fails** ("rollback skipped: stopped state could not be proven") | Existing | Unchanged | **No** — state is genuinely uncertain; could be mid-stop |
| Backup-phase failure, containment already proven | Aborts before migration; databases remain on the OLD schema, although WAL checkpointing may have changed file layout | Same reasoning as the `STOPPED_UNCHANGED` row above — services are down either way | **No** — same `STOPPED_UNCHANGED` state and reasoning |
| Migration or validation failure (mid-`migrate`/`validate` across the five databases) | **Already whole-cohort restore, verified by reading the script, not assumed:** `start_attempted` is set to `1` only after both `migrate` and `validate` complete. The `on_exit` trap fires on any nonzero exit and, when `start_attempted == 0`, `containment_verified == 1`, and a backup manifest exists, calls `restore_backups` for the *entire* manifest. `rollout-db.ts migrate`'s own plain-loop fail-fast means a mid-cohort failure stops there and lets this existing trap handle the whole-cohort restore. | **No new restore implementation required — an earlier draft of this section incorrectly described this as unhandled/to-be-built.** What's needed: a UAT case (§11) proving it under a real induced failure. `restore_backups` returning success is necessary but **not sufficient** on its own — see the `RESTORE_INCOMPLETE` state in §9 for what happens when it fails or can't be verified. | **Yes, but only if `restore_backups` succeeds AND post-restore SHA-256 verification passes for every database** — otherwise **No**, and the run lands in `RESTORE_INCOMPLETE` (§9), not `FAILED_RESTORED`. Note even the success case isn't "bare-retryable" — see §9's `FAILED_RESTORED` recovery flow, which still requires an explicit operator decision (retry vs. abandon), not an automatic re-invocation |
| Post-migration, post-validation, pre-start failure | Same trap: `start_attempted` is still `0` at this point, so this is *also* already whole-cohort restore, not "preserved" as an earlier draft stated. | Corrected description only — no behavior change. | Same as the row above |
| Post-start failure (service won't come up on new schema) | `start_attempted == 1` by this point, so the trap does *not* restore — migrated databases, evidence, and the failed service state are preserved for operator review (existing, and correctly distinct from the pre-start cases above: once a service has started against the new schema, an automatic DB rollback could race with in-flight writes, so this one genuinely does require manual judgment). | Unchanged | **No** — always requires operator review, never an automatic retry |
| Process killed / machine rebooted mid-rollout | Not explicitly guarded today | **New: interrupted-rollout sentinel (§6.4) forces a hard stop and manual review on the next invocation — never an automatic resume in either direction.** | **No** — nothing runs to set the flag |

## 8. Rollout state machine

```
IDLE
  │  (operator invokes with --expected-commit)
  ▼
LOCK_ACQUIRED (flock --exclusive, existing)
  │  sentinel checked HERE, under the lock — not before acquiring it (avoids the
  │  check-then-act race: a second invocation can't observe "no sentinel" and
  │  then acquire the lock after a third invocation has already failed)
  │  existing sentinel found ──▶ ABORT (exit nonzero, lock released, sentinel left in place, operator review required)
  ▼
SENTINEL_CREATED (O_CREAT|O_EXCL, atomic, still under the lock — see §6.4 for storage format) ──▶ PRECONDITIONS_CHECKED
  │ fail (stop_attempted still 0): release lock, sentinel_removable=true ──▶ sentinel removed, exit nonzero
  │   (services still active — a bare re-invocation behaves identically to the first attempt)
  ▼
STOPPING (stop_attempted=1 set here — from this point on, services go down regardless of what else fails,
  so a bare re-invocation can no longer just "try again": assert_service_active will reject it)
  │ primary stop fails ──▶ on_exit re-runs stop_and_verify_all_services:
  │     succeeds (containment re-proven, cohort backup did not complete and verify) ──▶ sentinel_removable=false ──▶
  │       STOPPED_UNCHANGED (sentinel remains; §9 for recovery — services down, source DBs remain on the old
  │       partial backup artifact may exist and must not be used for restore, code on new commit)
  │     fails ("stopped state could not be proven") ──▶ sentinel_removable=false ──▶ sentinel remains, exit nonzero
  ▼ (primary stop succeeds)
CONTAINMENT_PROVEN
  ▼
BACKED_UP (all five)
  │ fail: same STOPPED_UNCHANGED outcome as the STOPPING branch above — services are down either way, and no
  │   migration write has happened, so the recovery path is identical (a partial backup artifact from the failed
  │   backup attempt may exist on disk and must be discarded, not trusted, during that recovery)
  ▼
MIGRATING (all five, via openDb(); §6.2 — unchanged from today; plain fail-fast loop, no partial continuation)
  │ any failure ──▶ RESTORING (all five, existing on_exit trap — start_attempted still 0, containment re-verified)
  │     restore succeeds AND verified (SHA-256 match, every database) ──▶ sentinel_removable=true ──▶ FAILED_RESTORED
  │       (sentinel removed; §9 for recovery — services down, DB restored to OLD schema, code still on new commit;
  │       "sentinel removed" here means "safe to hand to the documented §9 recovery flow," not "safe to bare-retry")
  │     restore fails, partial, or unverified ──▶ sentinel_removable=false ──▶ RESTORE_INCOMPLETE
  │       (sentinel remains, exit nonzero, manual restoration required — see §9; NOT the same state as FAILED_RESTORED)
  ▼ all five succeed
VALIDATED (all five == CURRENT_SCHEMA_VERSION, requireCurrent check passes)
  │ fail ──▶ RESTORING (all five, same trap, same succeeds/fails split as above)
  ▼
STARTING (all seven units; start_attempted set to 1 here — trap no longer restores past this point)
  │ fail ──▶ STOPPED_PRESERVED (sentinel_removable=false always — sentinel remains present; migrated DBs + evidence preserved, no auto-rollback, operator review required)
  ▼
VERIFIED_ACTIVE ──▶ DONE (sentinel_removable=true; sentinel removed)
```

Interrupted at any state before a `sentinel_removable=true` outcome: the sentinel was created immediately after lock acquisition and is only removed on one of the three verified-safe outcomes (§6.4, §7) — `DONE`, a pure precondition failure, or verified full restoration (`FAILED_RESTORED` — which, once removed, still routes to §9's documented recovery flow rather than a bare re-invocation, since services are stopped). Every other terminal state (`STOPPED_UNCHANGED`, `RESTORE_INCOMPLETE`, `STOPPED_PRESERVED`, containment-unproven, or an interruption) retains the sentinel. The next invocation acquires the lock, finds the sentinel under that same lock (no race), hard-stops, and requires manual review — it does not attempt to infer which state was reached and resume.

## 9. Rollback state machine

Rollback is **restore, not down-migration** (locked decision 4), and only ever operates on the whole cohort (locked decision 7). Four states are distinguished — `STOPPED_UNCHANGED`, `FAILED_RESTORED`, `RESTORE_INCOMPLETE`, and `STOPPED_PRESERVED` — because they represent four materially different combinations of database schema state and code state, not one shared `RESTORE_INVOKED` step.

**Code state throughout every path below:** `git_check` requires the working tree to already be checked out at `expected_commit` (the new, target commit) for the *entire* duration of a rollout invocation — this is verified repeatedly, before stop and again after stop. So at the moment any of these four states is reached, **the working tree is still the new commit**; nothing in `rollout-agent-bridge.sh` itself ever reverts code. That is exactly why locked decisions 3 and 5 matter here: new code + old (possibly WAL-checkpointed or restored) schema is not a supported pairing, so the new code must never be started against a not-yet-migrated or restored database, and reverting to the previous commit is always a separate, explicit, manual step before any restart.

```
STOPPED_UNCHANGED (new state — services were stopped and containment was independently re-proven, but the cohort
  backup did not complete and verify (backup_completed=0 means the *whole cohort* wasn't verified, not that zero
  bytes were written — a partial, unmanifested backup artifact may exist under backup_set and must never be treated
  as valid or used for restore), and no migration write happened; sentinel_removable=false, sentinel retained per
  §7 — not because the state is ambiguous (it isn't: it's fully known), but because a bare re-invocation cannot
  proceed from here: rollout-agent-bridge.sh's own precondition check requires every unit to already be active
  before it will attempt to stop them. State: services stopped, source databases remain on the OLD schema; the
  offline WAL phase may have incorporated committed pages into a main file, but no migration write happened,
  code still checked out at the NEW commit — not started.)
  │
  ▼
OPERATOR_REVIEW (using the sentinel's recorded expected_commit/artifact_dir to find the right evidence, per §6.4)
  │
  ├─▶ recover to a known-good baseline first: PREVIOUS_CODE_CHECKED_OUT (revert the working tree to the previous
  │    commit — required before restart, since old schema + new code is not a supported pairing) ──▶
  │    SERVICES_RESTARTED (previous code + untouched previous-schema database — the pairing that was already
  │    running before this rollout attempt started) ──▶ once services are confirmed active again, a fresh rollout
  │    invocation can proceed normally (assert_service_active now passes)
  │
  └─▶ (future, separately reviewed option, not designed by this document) a dedicated "resume from stopped" rollout
       mode that explicitly tolerates services already being down instead of requiring PRECONDITIONS_CHECKED's
       assert_service_active — out of scope for 4C; the default, always-available recovery is the path above

FAILED_RESTORED (automatic on_exit trap restored the cohort AND verified it — §7; sentinel_removable=true, sentinel
  removed. State: services stopped, database restored to the OLD schema, code still checked out at the NEW commit
  — not started.)
  │
  ▼
VERIFY_RESTORED_COHORT (operator re-confirms: all five databases' SHA-256 match the pre-migration backup manifest —
  the automatic restore already checked this per-database during restore_backups; this is an operator-visible
  re-confirmation before deciding next steps, not a new mechanism)
  │
  ├─▶ retry: fix the root cause of the migration/validation failure, re-invoke with a corrected commit (services were
  │    never started against the new schema, so this is a fresh rollout attempt, not a partial resume)
  │
  └─▶ abandon: PREVIOUS_CODE_CHECKED_OUT (revert the working tree to the previous commit — separate, manual, outside
       this script; required before restart, since old schema + new code is not a supported pairing) ──▶
       SERVICES_RESTARTED (previous code + already-restored previous-schema database — a pairing that was already
       proven to work; services were stopped, not started, throughout, so this is a normal start, not a rollback of
       a running system)

RESTORE_INCOMPLETE (new state — the on_exit trap's restore_backups call itself failed, or succeeded but the
  post-restore SHA-256 verification did not match for every database; sentinel_removable=false, sentinel retained.
  State: unknown/mixed — some databases may be restored, some may still be on the failed-migration schema, some may
  be in an unverified intermediate state; services stopped; code still checked out at the NEW commit — not started.
  This is deliberately NOT the same state as FAILED_RESTORED — it must not be treated as "restored" until an
  operator has manually confirmed and corrected the database state.)
  │
  ▼
OPERATOR_MANUAL_RESTORATION (using the exact byte-level backup manifest and per-database evidence recorded before
  the failure — the same rollout-restore.py mechanics the automatic path uses, invoked by hand, database by
  database if necessary, until every database's SHA-256 matches its manifest entry)
  │
  ▼
VERIFY_RESTORED_COHORT (same check as the FAILED_RESTORED path — only once this passes does the system reach the
  equivalent of FAILED_RESTORED and proceed via retry/abandon as above)

STOPPED_PRESERVED (services stopped after a post-start failure. State: database IS on the NEW schema — migration
  and validation already succeeded before start was attempted; code checked out at the NEW commit; services WERE
  started against this pairing and then failed — the only state in this machine where new code + new schema was
  actually running, however briefly, before stopping. No automatic restore was attempted, per the always-manual-
  review rule in §7.)
  │
  ▼
OPERATOR_DECIDES: forward-fix the service issue and restart against the already-migrated new schema (new code +
  new schema — a supported pairing), OR roll back
  │
  ▼ (if rolling back)
OPERATOR_APPROVED_RESTORE_INVOKED (rollout-restore.py, existing mechanics — O_DIRECTORY|O_NOFOLLOW, atomic rename,
  mode/ownership preserved; this is the first restore attempt for this failure path, unlike FAILED_RESTORED where
  it already happened automatically)
  │ restore fails ──▶ RESTORE_INCOMPLETE (same state and manual-restoration path as above)
  ▼
VERIFY_RESTORED_COHORT (same SHA-256-against-manifest check as the FAILED_RESTORED path)
  │
  ▼
PREVIOUS_CODE_CHECKED_OUT (separate, manual: revert the working tree to the previous commit — required before
  restart, since old schema + new code is not a supported pairing, and the code was never reverted by this script)
  │
  ▼
SERVICES_RESTARTED (previous code + restored databases — a pairing that was already proven to work)
```

There is no state in this machine that represents "new code + old schema" *running* as a supported combination — `STOPPED_UNCHANGED`'s, `FAILED_RESTORED`'s, and `STOPPED_PRESERVED`'s rollback branches all explicitly revert code *before* restart, never after; services stay stopped the entire time new code and old schema coexist on disk. `STOPPED_PRESERVED`'s forward-fix branch is the only path where new code runs against new schema, which is the pairing the migration was for in the first place.

## 10. Phased implementation plan

| Phase | Scope | Depends on |
|---|---|---|
| 4C.1 | This document, reviewed and merged (docs only) | — |
| 4C.2 | `openProductionDb()` added to `src/db.ts`, additive (§6.1); `openDb()` completely unchanged; shared WAL/FK/construction tail extracted into a private helper both call; `MigrationRequiredError`/`DatabaseMissingError`; the five service entrypoints switched to `openProductionDb()`; **deny-by-default** arch-lint rule prohibiting `openDb`, `applyMigrations`, `applyMigrationsUpTo`, and `applyLegacyCompatibleBaseline` under all of production `src/` except their own three defining files (§6.6); characterization tests proving every existing `openDb()`/`applyMigrations()`/`applyMigrationsUpTo()`/`applyLegacyCompatibleBaseline()` call site (tests, dev tooling, `rollout-db.ts`) is unaffected; new tests for `openProductionDb()`'s legacy-fails-closed and missing-file-fails-closed paths | 4C.1 |
| 4C.3 | New `rollout-db.ts bootstrap` mode (§2, §3) reusing `openDb()`'s existing missing-file path at the database layer, plus new root-owned allowlist/ownership/atomic-creation/cleanup-on-failure machinery at the rollout-helper level; per-database resolving-units evidence field. `rollout-db.ts migrate` itself is unchanged. | 4C.2 |
| 4C.4 | `rollout-agent-bridge.sh` interrupted-rollout sentinel: full storage spec (fixed root-owned path under `log_dir`, regular file, mode 0600, atomic write, structured contents — §6.4); lock-then-sentinel ordering; guarded clearing (automatic only within the same invocation under the same lock, or a separate explicitly-reviewed manual operator action); the explicit `sentinel_removable` flag (§7) gated on whether a bare re-invocation can actually proceed, not just on containment or which phase failed; the new `STOPPED_UNCHANGED` state (§9) for a stopped-but-database-untouched failure, and `RESTORE_INCOMPLETE` (§9) for a failed or unverified automatic restore — both distinct from `FAILED_RESTORED` | 4C.3 (can proceed in parallel with 4C.3 if reviewed as a separate PR) |
| 4C.5 | Full test/UAT matrix (§11) executed against a non-production fixture environment, including a UAT case proving the *already-existing* whole-cohort restore-on-migration-failure behavior (§7) under a real induced failure, and separate UAT cases for all four §9 rollback paths (`STOPPED_UNCHANGED`, `FAILED_RESTORED`, `RESTORE_INCOMPLETE`, `STOPPED_PRESERVED`) | 4C.2–4C.4 merged |
| 4C.6 | This issue's Phase 4C acceptance criteria reviewed and checked off; Issue #135 updated | 4C.5 |
| 4C.7 | Production deployment (§12 runbook), including offline WAL drain, verified backup, migration, validation, service restart and evidence closeout | 4C.6, explicit human approval |

Each of 4C.2–4C.4 is its own draft PR through the same review discipline as PRs #147/#154 (red-green-refactor, full parallel+serial suite, arch-lint, exact-head CI, no merge without explicit approval).

### Phase 4C.6 closeout record

Phase 4C.5 is complete: PR #176 merged to `main` as `38b45ae8fe450b3b54072ba7f23ed9c841391cc4` from approved head `d58788cca79a050f54fe20c764e6e322d8bdc5d9`. Exact-head evidence recorded 76 real-systemd/UAT tests passed; serial and parallel suites each recorded 1,911 passed and 9 skipped; typecheck, Architecture Lint, diff/path audit and Knip-vs-main comparison passed. The migration implementation was verified byte-for-byte unchanged after extraction behind the fail-closed executable boundary.

Phase 4C acceptance reconciliation:

- ordinary startup and guarded rollout now have one reviewed migration-ownership contract;
- minimum/current/future schema behavior and rollback expectations are documented and tested;
- no schema-changing production deployment has occurred before the gate was ready;
- full parallel/serial tests, typecheck, Architecture Lint, exact-head CI and static comparisons passed;
- compatibility retirement remains Phase 5 scope and is not claimed by this closeout.

### Phase 4C.7 production deployment closeout

Phase 4C.7 is complete. The guarded rollout ran successfully at deployed head `8c74c3f78f3742297cf4346ec3458124d9d64749`; PR #184 merged that unchanged tree as `f3c40327763c4b3232a86e0e6e073545bdbd84cf`. No second rollout or restart was performed after the merge because the merge added no file changes.

Final evidence: `/var/log/agent-bridge-rollouts/20260721T114637Z-8c74c3f78f3742297cf4346ec3458124d9d64749` (`rollout.log`, `containment-evidence.json`, `checkpoint-evidence.json` plus SHA-256, `backup-manifest.tsv`, `migration-evidence.json`, `validation-evidence.json`, and `post-start-evidence.json`). The checkpoint evidence recorded interactive WAL `2,401,992` bytes and worker WAL `366,712` bytes drained to zero before backup; all five databases passed integrity/current-schema validation with zero legacy and pending queue rows; all seven services were active/running; the rollout sentinel was absent; and startup error smoke was clean.

The Phase 4C production deployment runbook in §12 is complete. Phase 4C is complete; compatibility retirement remains Phase 5 scope.

## 11. Test and UAT matrix

| Case | Level | Proves |
|---|---|---|
| Every existing `openDb()`/`applyMigrations()`/`applyMigrationsUpTo()`/`applyLegacyCompatibleBaseline()` call site across `test/*.ts` and `scripts/rollout-db.ts` | Full regression suite (must stay green throughout 4C.2) | All four primitives are genuinely untouched — no test rewrite, no behavior change |
| `openProductionDb()` on a `current`-version DB | Unit (new) | Starts normally, same as `openDb()` would |
| `openProductionDb()` on a `future`-version DB | Unit (new) | Fails closed before WAL, `UnsupportedSchemaVersionError` |
| `openProductionDb()` on a `legacy`-version (`user_version = 0`) DB | Unit (new, must be red before 4C.2, green after) | Fails closed with `MigrationRequiredError`; no WAL/write occurs (mirrors the PR #147 future-version test's sidecar-file assertions) |
| `openProductionDb()` on a missing file | Unit (new, must be red before 4C.2, green after) | `fileMustExist: true` prevents implicit creation; no directory or file appears on disk (assert via `existsSync` before/after, mirroring the sidecar-file pattern above) |
| The five service entrypoints, each importing `openDb` directly instead of `openProductionDb` | Arch-lint regression (new) | The known five files are still caught |
| A fixture **non-entrypoint** `src/` module (not one of the five known files) importing `openDb` directly | Arch-lint regression (new) | The rule is genuinely deny-by-default across production `src/`, not scoped to five specific filenames |
| A fixture `src/` module importing `applyMigrations`, `applyMigrationsUpTo`, or `applyLegacyCompatibleBaseline` directly, with **no** `openDb` import at all | Arch-lint regression (new) | The primitive-level bypass (calling the migration functions directly against a raw connection, skipping `openDb`/`openProductionDb` entirely) is closed, not just the `openDb`-shaped one — this is the case an earlier draft's narrower rule would have missed entirely |
| `rollout-db.ts inspect` on the real five-role shape, with shared antigravity/claude/codex path | Integration (new) | Canonicalisation correctly collapses three units to one database, no double-processing |
| `rollout-db.ts bootstrap` on a genuinely missing database | Integration (new) | New role creation works via the existing `openDb()` migration-plan path, distinct from ordinary `migrate` — never triggered implicitly by `inspect`/`migrate`/`validate` |
| Sentinel with unsafe ownership (not root-owned) | Unit/integration (new) | Refused before its contents are trusted, matching the existing config-file ownership discipline |
| Sentinel with unsafe permissions (group/world writable) | Unit/integration (new) | Refused, same standard as `backup_dir`/`log_dir`/the config file |
| Sentinel path is a symlink | Unit/integration (new) | Refused — never followed, matching every other file operation in this script |
| Sentinel with stale/mismatched metadata (recorded `expected_commit`/`artifact_dir` doesn't match the invocation reviewing it) | Unit/integration (new) | A manual clear attempt cannot be pointed at the wrong evidence by a stale sentinel |
| Two invocations attempting to clear the same sentinel concurrently | UAT, non-production fixture environment (new) | Clearing only ever happens under the `flock`, so a genuine race is structurally impossible — this test proves the second invocation blocks/aborts rather than racing |
| Manual clear tool invoked while an active rollout still holds the `flock` | UAT, non-production fixture environment (new) | The manual path is refused at lock acquisition — `flock --exclusive --nonblock` fails, the tool aborts immediately, and the sentinel is left completely untouched (not partially read, not deleted) — proving the lock requirement is structural, not a documented convention the manual tool could accidentally skip |
| `rollout-agent-bridge.sh` failing after `stop_attempted=1`, containment independently re-proven, cohort backup did not complete and verify | UAT, non-production fixture environment (new) | Lands in `STOPPED_UNCHANGED` (§9) with `sentinel_removable=false` — proves the corrected logic doesn't auto-clear just because no migration ran, and that a partial backup artifact is reported rather than claimed not to exist |
| `rollout-agent-bridge.sh` failing after `stop_attempted=1` where containment **cannot** be re-proven | UAT, non-production fixture environment (new) | `sentinel_removable=false`, same as above but via the "uncertain" path rather than the "known-but-unrecoverable-by-bare-retry" path |
| A bare re-invocation attempted immediately after a `STOPPED_UNCHANGED` outcome, without following the §9 recovery path | UAT, non-production fixture environment (new) | Confirms the premise driving this whole fix: the sentinel blocks it first, and even if it didn't, `assert_service_active` would reject it — the state genuinely isn't bare-retryable |
| `rollout-agent-bridge.sh` with one of five databases deliberately made unmigratable (e.g. injected FK violation, per PR #147's `foreign_key_check` gate) | Integration/UAT (new) | The **existing** whole-cohort restore (via `on_exit`'s `start_attempted == 0` check, §7) actually triggers under a real failure, lands in `FAILED_RESTORED`, and `sentinel_removable` is correctly set only after verified restoration |
| Same as above, but `restore_backups` itself is forced to fail | UAT, non-production fixture environment (new) | The run lands in `RESTORE_INCOMPLETE` (§9), not `FAILED_RESTORED` — `sentinel_removable` stays false, and the state is distinguishable from a genuinely restored cohort |
| Two concurrent `rollout-agent-bridge.sh` invocations racing for the lock, one with a prior failed run's sentinel present | UAT, non-production fixture environment (new) | The corrected lock-then-sentinel ordering (§6.4) actually closes the race, not just on paper |
| `rollout-agent-bridge.sh` killed mid-`MIGRATING` (simulated) | UAT, non-production fixture environment | Sentinel present on next invocation; hard stop; no auto-resume in either direction |
| `rollout-agent-bridge.sh` full run against a five-database fixture cohort seeded with realistic legacy shapes (reuse PR #147's fixed pre-versioned SQL fixtures) | UAT, non-production fixture environment | End-to-end containment → backup → migrate → validate → start → verify, matching `docs/GUARDED-ROLLOUT.md`'s documented sequence exactly |
| Full rollback drill, `STOPPED_UNCHANGED` path: fixture cohort, forced stop-phase failure, manual code revert, manual restart of the previous pairing, then a fresh rollout invocation succeeds | UAT, non-production fixture environment (new) | §9's `STOPPED_UNCHANGED` recovery path actually restores the system to a state a fresh rollout can proceed from |
| Full rollback drill, `FAILED_RESTORED` path: fixture cohort, forced mid-migration failure, automatic restore, verify byte-identical to pre-migration backup via SHA-256, confirm code is reverted to the previous commit *before* restart | UAT, non-production fixture environment | Locked decisions 3, 4, 5, and 7 hold under a real (if fixture-scale) failure; §9's `FAILED_RESTORED` path is followed, and new-code-against-restored-schema is never started |
| Full rollback drill, `RESTORE_INCOMPLETE` path: fixture cohort, forced automatic-restore failure, manual operator restoration, verify the cohort only proceeds once every database's SHA-256 matches | UAT, non-production fixture environment (new) | §9's distinct `RESTORE_INCOMPLETE` state is actually exercised, not silently conflated with `FAILED_RESTORED` |
| Full rollback drill, `STOPPED_PRESERVED` path: fixture cohort, forced post-start service failure, manual operator-approved restore invocation, confirm code is reverted before restart | UAT, non-production fixture environment (new) | §9's distinct `STOPPED_PRESERVED` path — database on new schema, no automatic restore, requires explicit operator invocation — is actually exercised, not conflated with any path above |
| Existing rollout-helper test suite (`test/rolloutHelper.test.ts`, 39 tests) | Regression | No existing containment/backup/evidence guarantee regresses |

## 12. Production deployment runbook (4C.7 — complete)

This runbook was executed successfully at deployed head `8c74c3f78f3742297cf4346ec3458124d9d64749` and is retained as the operational record. The subsequent PR merge commit `f3c40327763c4b3232a86e0e6e073545bdbd84cf` changed no deployed files; no second rollout or restart was required.

1. Confirm 4C.2–4C.6 merged to `main`; record the exact `main` SHA to be deployed.
2. Inventory the live instance: confirm all seven units and five canonical database paths match §4 exactly (no drift since this document was written).
3. Take and independently verify rollback backups (the guarded rollout helper does this as part of its own sequence, but a pre-flight manual backup + off-host copy is a reasonable additional safety margin given this is the first real-world exercise of the new gating model).
4. Dry-run `rollout-db.ts inspect` against the live five databases (read-only) to confirm current schema state, zero legacy queue count, and expected resolving-units mapping before touching anything.
5. Obtain explicit, separate human authorization for the actual rollout (per this project's standing rule — no deployment proceeds on implicit approval).
6. Invoke `sudo -n /usr/local/sbin/rollout-agent-bridge --expected-commit <exact 40-char SHA>`.
7. On success: verify every service active, `rollout-db.ts validate` reports `current` for all five, queues intact (counts match pre-rollout inspect), logs show no migration/credential/process-lifecycle errors. **Completed:** all seven services were active/running; all five databases were integrity-valid/current with zero legacy and pending queue rows; checkpoint evidence recorded the interactive and worker WAL drains; backup and SHA-256 manifests were present; startup error smoke was clean; and the sentinel was absent.
8. On any failure: do not attempt manual remediation — follow the evidence path recorded in `log_dir/latest`, and if rollback is warranted, use the state machine in §9. Report the exact failure per this thread's standing reporting convention.

---

Refs #135. This document supersedes no prior decision recorded in Issue #135; it implements the Phase 4C section already present there.
