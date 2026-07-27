# Guarded production rollout

Status: operational contract and installation guide. Installing or merging this helper does not authorize a production rollout.

See `docs/roadmap/issue-135-phase4c-migration-ownership.md` for the schema-migration ownership and gating policy layered on top of this helper (Issue #135 Phase 4C) — the migration/validation steps described below are being brought under that policy's stricter "ordinary startup never auto-migrates" contract.

Issue #183's server-side artifact work begins with the staging-only helper in
`docs/RELEASE-ARTIFACT-STAGING.md`, followed by the controlled pointer boundary
in `docs/RELEASE-POINTER-ACTIVATION.md`. In immutable release mode this rollout
helper now owns the complete stop-and-switch boundary: it validates the active
and target releases, drains WALs, backs up and migrates databases, atomically
activates `current`, and starts the selected services from that pointer.

## Safety model

`rollout-agent-bridge` is a root-owned, narrow orchestration helper. It is separate from `restart-agent-bridge` and accepts only an exact, full Git commit SHA. In immutable release mode, `release_root` and `current_pointer` must identify the validated staged release before any service stop. It never fetches, pulls, checks out, resets, commits, discards queues, or changes its fixed service/database inventory.

The enforced sequence is:

Before this sequence, production requires a canonical mode-0600 authorization
file containing `principal`, `reference`, `approved_target_commit`, UTC
`approved_at`, UTC `expires_at`, bounded `scope`, and the exact approved
artifact/evidence, environment, rollout-helper, rollout-config,
authorization-validator, and acceptance-validator SHA-256 identities. The
trusted validator compares every identity against the invocation and the
root-owned fixed configuration before any mutation; absent, malformed, stale,
or mismatched approval fails closed. A current pointer already equal to the
target is a no-op and is rejected: it cannot emit `POINTER_SWITCHED`,
`ACCEPTED`, or `COMPLETE`.

1. Acquire the exclusive OS rollout lock.
2. Verify the root-owned config, selected units from the compiled seven-unit allowlist, clean `main`, and the exact expected commit. In immutable release mode, every selected service's effective `BRIDGE_CURRENT_RELEASE_DIR` must equal the configured `current_pointer`; explicit systemd overrides are rejected. Units may already be quiesced; any active unit must be stably running, and every unit is still stopped and containment-verified before migration. Every Git command runs as the runtime user.
3. Resolve each selected unit's effective `DB_PATH` or `HEALTH_DB_PATH` using shared-then-unit environment-file precedence. Reject defaults, unknown units, missing files, non-canonical paths, duplicates, inventory mismatches, unknown schemas, integrity failures, or nonzero legacy queues.

The target database schema is not an operator-supplied workflow input. Historical
artifact builds derive the schema contract from the target source/runtime and
record it in the manifest; offline validation extracts that recorded contract
and applies the corresponding schema-specific table checks. A claimed schema
that does not match the artifact manifest is rejected.

4. Stop every service and prove containment from `MainPID=0`, `ControlPID=0`, and an empty unit cgroup. A nonzero stop result is retained as diagnostic evidence; `inactive/dead`, `inactive/exited`, and process-free `failed/dead|failed` states are accepted. An empty `ControlGroup` is accepted only as systemd's affirmative no-cgroup report on a dead unit; a non-empty `ControlGroup` must resolve to a real, non-symlink, fully readable cgroup directory, and any cgroup state that cannot be inspected reliably fails containment.
5. After containment, run the runtime-user SQLite checkpoint phase with `wal_checkpoint(TRUNCATE)` for every database. This is an offline drain: a non-empty WAL is incorporated into the main database before backup, never deleted directly. A busy/failed checkpoint, a remaining non-empty WAL, or an uncertain sidecar remains a hard failure.
6. Remove only regular, non-symlink SQLite sidecars whose WAL is exactly zero bytes, and record the checkpoint evidence and SHA-256 manifest.
7. Recheck Git and database preconditions.
8. Create byte-exact SQLite backups after proving no WAL/SHM sidecars remain. Record and verify source/backup UID, GID, mode, size, canonical path, and SHA-256.
9. Run the repository's additive migrations and validate the current schema.
10. In immutable release mode, atomically switch `current` to the target release and record the old/new pointer identity before any service start.
11. Reset failed state for every selected unit before capturing the `NRestarts` baselines, then start every service, verify active state, inspect startup error logs, and revalidate databases. The systemd journal's benign `-- No entries --` response is accepted; actual error output remains fatal.

Every phase writes a timestamped log plus JSON evidence and SHA-256 manifests beneath pre-existing, canonical, root-owned directories. Immutable release evidence records the expected and previous commits, active pointer, target release directory, and the SHA-256 of the exact rollout helper used. Pointer-switch evidence records the old and new targets. Containment evidence records each unit's active/sub states, result, main exit code/status, main/control PIDs, cgroup path, and remaining cgroup PIDs. The manifest records each database parent directory's device, inode, ownership, and mode before migration. A failure before the first start attempt restores every database only after all services are proven stopped; in immutable release mode it then reactivates the verified previous release and proves the previous services healthy. The fixed root-owned restore helper opens the expected parent with `O_DIRECTORY|O_NOFOLLOW`, verifies its descriptor identity, removes every directory write bit for the critical section, and restores the exact original mode in `finally`. Restore files use `O_CREAT|O_EXCL|O_NOFOLLOW`; copying, metadata changes, verification, and final destination inode checks stay descriptor-relative through the atomic rename. A containment failure skips rollback and reports `CONTAINMENT INCOMPLETE`. A failure during or after a start attempt stops and verifies all services, preserves migrated databases and evidence, and requires operator review. The helper deliberately does not attempt an automatic post-start code/database rollback.

## Installation

Review and install the helper and fixed inventory as root:

```bash
sudo install -D -m 0750 -o root -g root scripts/rollout-agent-bridge.sh /usr/local/sbin/rollout-agent-bridge
sudo install -D -m 0750 -o root -g root scripts/rollout-restore.py /usr/local/libexec/agent-bridge-rollout-restore
sudo install -D -m 0750 -o root -g root scripts/rollout-authorization.py /usr/local/libexec/agent-bridge-rollout-authorization.py
sudo install -D -m 0750 -o root -g root scripts/rollout-acceptance.py /usr/local/libexec/agent-bridge-rollout-acceptance.py
sudo install -d -m 0700 -o root -g root /var/backups/agent-bridge /var/log/agent-bridge-rollouts
sudo install -D -m 0600 -o root -g root systemd/agent-bridge-rollout.conf.example /etc/agent-bridge/rollout.conf
sudo sha256sum /usr/local/sbin/rollout-agent-bridge
sudoedit /etc/agent-bridge/rollout.conf
sudo visudo -f /etc/sudoers.d/agent-bridge-rollout
```

Write the displayed digest as `rollout_helper_sha256=` in the root-owned
config. Production execution fails closed when this pin is missing, malformed,
or does not match the installed helper bytes, preventing a stale legacy helper
from stopping services under an immutable-release configuration.

Also record the SHA-256 digests of the independently installed validators as
`authorization_validator_sha256=` and `acceptance_validator_sha256=`. The
rollout helper verifies both pins before reading the target release or running
target-owned code; target-release copies of these validators are never trusted.
Record a stable `environment=` identity in the same fixed config. The approval
must repeat that identity exactly. The deployment invocation must also provide
the independently verified artifact and qualification-evidence SHA-256 values:

```bash
sudo -n /usr/local/sbin/rollout-agent-bridge \
  --expected-commit <full-40-character-main-sha> \
  --artifact-sha256 <artifact-sha256> \
  --evidence-sha256 <qualification-evidence-sha256> \
  --environment <fixed-environment-identity> \
  --authorization-file <root-owned-approval.json>
```

Sudoers content:

```sudoers
content-crawler ALL=(root) NOPASSWD: /usr/local/sbin/rollout-agent-bridge
```

The config must remain `root:root` and must not be group/world writable. Select a fixed subset of the compiled unit allowlist and list the exact canonical, non-symlink database set those units resolve from `/etc/default/agent-bridge-shared` followed by their unit-specific environment file. Multiple units may intentionally share one database; duplicate `database=` entries are forbidden. The helper aborts if discovery and the allowlist differ. `backup_dir` and `log_dir` must already exist as canonical, root-owned directories with no group/world write bits.

## Authorized invocation

Only after separate production approval:

```bash
sudo -n /usr/local/sbin/rollout-agent-bridge --expected-commit <full-40-character-main-sha> --artifact-sha256 <artifact-sha256> --evidence-sha256 <qualification-evidence-sha256> --environment <fixed-environment-identity> --authorization-file <root-owned-approval.json>
```

The manifest/runtime contract must prove every declared archived path, type,
hash, symlink target, package-lock digest, migration helper, authorization
validator, entrypoint, `tsconfig.json`, and `tsx` runtime. After startup,
bounded acceptance compares each database's queue counts, claim/acquisition
correlation, execution-lock state, run/lock correlation, and delivery state
before and after. Any active or ambiguous lock fails closed; only a separately
documented continuation contract can permit it. Sentinel removal and
`COMPLETE` occur only after this evidence passes.

Artifacts are written beneath the configured `log_dir`; database snapshots are written beneath `backup_dir`. On any failure, keep services stopped and inspect the newest artifact path recorded in `log_dir/latest` before taking further action.

## Recovery-readiness baseline gate

Issue #193 reconciliation is a recovery-readiness operation, not a rollout
authorization. It may classify and reconcile only demonstrably stale runs or
locks after containment is proven; it never deletes or replays queue, claim,
run, event, or pending-message rows. Ambiguous ownership remains preserved for
manual review.

The offline baseline validator requires copied database fixtures and an
artifact manifest containing the exact target commit/tree, package-lock hash,
builder commit, builder workflow run/head, and target database schema version.
The workflow independently verifies the artifact run's head before invoking
the validator. Its result is named `schema_compatibility` because it validates
copied-fixture integrity and schema, not the target runtime opener. The
pre-start simulation uses atomic temporary-symlink replacement for both target
activation and restoration; it never touches production pointers or databases.

For historical artifacts, the successful workflow run must be the named
`Historical Release Artifact` workflow, its run head must equal the reviewed
builder commit, and the manifest must still bind the target commit/tree to the
historical inputs. The expected target schema is an explicit workflow input;
it is never inferred from the current checkout.

The forward path is therefore: reconcile proven stale state; build a fresh
immutable artifact; validate it offline against copied production-state
fixtures; obtain independent approval; then request a separately authorized
guarded rollout. No existing ambiguous release is an automatic rollback
baseline.

Legacy queue discard is intentionally unsupported. A nonzero legacy queue count aborts before service stop and requires a separate explicit operational decision and tool.

## Bootstrap: genuinely missing databases (Phase 4C.3, issue #135)

A database that doesn't exist yet — first install, or a genuinely new role added later — is not "behind schema," it's absent. `rollout-agent-bridge` never creates one implicitly: `inspect`/`migrate`/`validate` all require every configured database to already exist. Creating a new-role database is a **separate, explicitly-invoked** tool, `rollout-bootstrap`, with its own fixed allowlist. It is never bundled into the same invocation as a migration of existing databases — no pre-migration backup exists for a database that didn't exist, so it cannot participate in the whole-cohort restore guarantee the ordinary rollout provides.

`rollout-bootstrap` reuses `openDb()`'s existing, already-tested missing-file → full-migration-plan path (`scripts/rollout-db.ts bootstrap`) at the database layer — the same migration 1 DDL every other database goes through, so there is no duplicated or shortcut schema definition — but creates the file atomically: a randomly-named temp file in the target's own directory, migrated to `CURRENT_SCHEMA_VERSION`, then validated (integrity check, foreign-key check, exact schema version) before it is ever published. Publication itself uses no-replace `link()`+`unlink()` semantics, not `rename()` — a destination that appears concurrently (a genuine race, not just a stale precondition check) makes the `link()` fail with `EEXIST` rather than silently overwriting whatever is there.

Any failure **before** the final `link()`+`unlink()` commit step — the missing-file precondition, parent-directory validation, the migration itself, post-migration validation, a concurrent-destination race at publish time, or a `SIGTERM`/`SIGINT` serviced at one of the two real checkpoints (after migration, after validation) — removes the temp file (and any `-wal`/`-shm` sidecars) and leaves the final path completely untouched.

The `link()`+`unlink()` step itself is a deliberately minimal, uninterrupted synchronous pair — nothing yields there, so it stays as short as two syscalls. A `SIGKILL` or machine reboot landing in that specific, narrow window — after `link()` publishes the database but before `unlink()` removes the temp name — **is not observable or handleable by any process**, the same as any other unrecoverable interruption. It leaves the destination fully valid (the same already-validated content, already published) plus a harmless extra hard link at the stale temp name. The **next** bootstrap attempt against that same target recovers it automatically, under the same exclusive lock, by verifying the stale name shares the destination's exact inode before removing it — this runs even though the destination already exists by then, which is exactly the case an ordinary "already exists" refusal would otherwise mask. A name match with a *different* inode is treated as unexpected and requires manual operator review rather than being silently deleted.

### Installation

```bash
sudo install -D -m 0750 -o root -g root scripts/rollout-bootstrap.sh /usr/local/sbin/rollout-bootstrap-agent-bridge
sudo install -D -m 0600 -o root -g root systemd/agent-bridge-rollout-bootstrap.conf.example /etc/agent-bridge/rollout-bootstrap.conf
sudoedit /etc/agent-bridge/rollout-bootstrap.conf
sudo visudo -f /etc/sudoers.d/agent-bridge-rollout-bootstrap
```

Sudoers content:

```sudoers
content-crawler ALL=(root) NOPASSWD: /usr/local/sbin/rollout-bootstrap-agent-bridge
```

The config must remain `root:root`, must not be group/world writable, and lists only `project_dir`, `runtime_user`, `node_bin`, and one or more `bootstrap_role=<role>:<absolute path>` entries — the fixed allowlist of exact **role/path pairs** this tool is ever permitted to create, not bare paths. `<role>` must be one of the five canonical roles (`shared`, `discord`, `health`, `interactive`, `worker`; see the five-database-role inventory in `docs/roadmap/issue-135-phase4c-migration-ownership.md` §4). It is a separate config file from `rollout.conf`; a path is not eligible for bootstrap just because it appears in the ordinary rollout's `database=` allowlist, and vice versa.

### Authorized invocation

Only after separate production approval, confirming the missing file is an expected new role rather than misconfiguration or accidental deletion:

```bash
sudo -n /usr/local/sbin/rollout-bootstrap-agent-bridge --role <shared|discord|health|interactive|worker> --new-role <absolute path> --confirm-new-role <same absolute path>
```

`--confirm-new-role` must exactly repeat `--new-role` — an explicit, per-invocation operator confirmation, the same exact-match discipline `--expected-commit` uses elsewhere in this tooling. `--role` must name one of the five canonical roles, and the exact `(role, path)` **pair** — not the path alone — must appear in the fixed `bootstrap_role` allowlist; the correct path under the wrong role is refused just like an unlisted path. The target must not already exist and must not be a symlink, even a dangling one (`-e`/`-L` are both checked — a plain existence check alone would miss a dangling symlink sitting at the target path), and must sit under a canonical, non-symlink parent directory with no group/world write bits. `rollout-bootstrap` acquires the **same** exclusive OS lock file as `rollout-agent-bridge`, so a bootstrap can never run concurrently with an active migrate rollout, even though the two are structurally separate tools and invocations.

## Interrupted-rollout sentinel (Phase 4C.4, issue #135)

`rollout-agent-bridge` writes a fixed, root-owned regular file, `$log_dir/.rollout-in-progress`, mode `0600`, immediately after acquiring the exclusive rollout lock and before any precondition check runs — including the artifact-directory-uniqueness check. Its purpose is a hard stop: if a rollout is interrupted mid-flight (the process killed, the machine rebooted), the *next* invocation must never silently proceed as if nothing happened. It refuses instead, citing the sentinel's own recorded `expected_commit`, `artifact_dir`, and append-only phase ledger as evidence for what needs manual review.

Creation is atomic — a `mktemp`'d temp file in the same directory, `chmod 0600`, then a hard link (`ln`) from the temp name to the fixed sentinel path. `ln` fails if the destination already exists rather than replacing it, giving `O_CREAT|O_EXCL` create-if-absent semantics without a custom syscall wrapper. An existing sentinel that is a symlink, not a regular file, or has the wrong owner/mode is never trusted or silently overwritten — that is its own containment-uncertain failure, refused with instructions to inspect it manually and clear it with the separate `rollout-sentinel-clear` tool rather than retry.

The sentinel is removed automatically in exactly three cases, gated by an internal `sentinel_removable` flag that is never inferred from the script's exit status (which stays nonzero on every failure path, including a cleanly auto-restored one):

- The rollout completes successfully end to end.
- A precondition fails strictly before any service stop is attempted — nothing was touched, so there is nothing to review.
- The automatic post-failure restore (`FAILED_RESTORED`) both succeeds and is verified — every database's SHA-256 matches the pre-migration manifest, and the previous release passes bounded pointer, service-stability, journal-smoke captured from immediately before recovery start, post-smoke service rechecks, restart-counter, database, and queue/claim acceptance. The previous release is running when this state is reported; sentinel removal means only "safe to hand to the documented recovery flow below," never "safe to bare-retry."

In every other failure shape the sentinel is retained and the failure is labeled with one of four states, so an operator can pick the correct recovery path without having to reconstruct what happened from logs alone:

| State | Meaning | Recovery |
|---|---|---|
| `STOPPED_UNCHANGED` | Services stopped, containment re-proven, but the cohort backup did not complete and verify. The source databases remain on the OLD schema; the offline WAL phase may already have incorporated committed pages into a main file, but no migration ran. `backup_completed=0` only means the *whole cohort* wasn't verified; a partial, unmanifested backup artifact may exist under the run's `backup_set` directory and must never be treated as a valid backup or used for restore. The checked-out code is still the NEW commit. | **Not** bare-retryable — services are stopped and `assert_service_active` rejects a re-invocation until they're active again. Review the sentinel's recorded evidence, discard any partial backup artifact, revert the working tree to the previous commit (old schema + new code is not a supported pairing), restart the previous services, confirm they're active, then start a fresh rollout. |
| `FAILED_RESTORED` | A genuine restore attempt ran, every database verified against the manifest, and the previous release passed recovery acceptance. | Not a bare-retry case — review why migration failed before retrying. |
| `RESTORE_INCOMPLETE` | The automatic restore itself failed, or could not be fully verified for every database. State is unknown/mixed. | Manual restoration required before anything else; do not start services. |
| `STOPPED_PRESERVED` | Services stopped after a post-start failure. Database IS on the NEW schema — migration and validation already succeeded, and services were briefly started against this pairing before failing. | Always requires operator judgment; no automatic action is safe with services possibly having accepted live writes. |

### Clearing a retained sentinel

Clearing is never a bare `rm`. A separate, equally guarded tool, `rollout-sentinel-clear`, is the only sanctioned way to remove a retained sentinel:

```bash
sudo install -D -m 0750 -o root -g root scripts/rollout-sentinel-clear.sh /usr/local/sbin/rollout-sentinel-clear
sudo visudo -f /etc/sudoers.d/agent-bridge-rollout-sentinel-clear
```

Sudoers content:

```sudoers
content-crawler ALL=(root) NOPASSWD: /usr/local/sbin/rollout-sentinel-clear
```

It reads the same `/etc/agent-bridge/rollout.conf` as `rollout-agent-bridge` (only `log_dir` is required from it) — no separate config file. Invocation:

```bash
sudo -n /usr/local/sbin/rollout-sentinel-clear --expected-commit <full-40-character-sha> --artifact-dir <absolute path>
```

It acquires the **same** exclusive rollout lock before touching anything — if a rollout is genuinely active, the clear tool refuses immediately (`a rollout is currently active — refusing to touch the sentinel while it may still be in use`) and leaves the sentinel completely untouched, rather than racing it. Once the lock is held, it re-validates the sentinel's ownership, mode, and non-symlink status, then cross-checks the operator-supplied `--expected-commit` and `--artifact-dir` against the values *recorded in the sentinel itself*. A mismatch on either field refuses and names the recorded value — proving the operator has actually reviewed the evidence for *this* sentinel, not a stale one left over from an unrelated earlier attempt. On success it appends an audit line to `$log_dir/sentinel-clear.log` before removing the sentinel.
