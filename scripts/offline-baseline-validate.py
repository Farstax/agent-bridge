#!/usr/bin/env python3
"""Validate a release artifact and copied SQLite cohort without production access."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sqlite3
import stat
import subprocess
import tarfile
import tempfile
from pathlib import Path

SHA = 40
SHA256 = 64
CORE_TABLES = {"bridge_runs", "bridge_events", "execution_locks", "pending_messages"}
SCHEMA_TABLES = {4: CORE_TABLES | {"reconciliation_audit"}}


def fail(message: str) -> None:
    raise SystemExit(f"offline baseline validation failed: {message}")


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def safe_extract(archive: Path, destination: Path) -> None:
    with tarfile.open(archive, "r:gz") as tar:
        members = tar.getmembers()
        for member in members:
            name = Path(member.name)
            if name.is_absolute() or ".." in name.parts:
                fail(f"archive path escapes extraction root: {member.name}")
            if member.issym() or member.islnk():
                target = Path(os.path.normpath(str(name.parent / member.linkname)))
                if target.is_absolute() or ".." in target.parts:
                    fail(f"archive link escapes extraction root: {member.name}")
            if not (member.isdir() or member.isfile() or member.issym()):
                fail(f"unsupported archive member: {member.name}")
        tar.extractall(destination)


def walk(root: Path) -> dict[str, dict[str, object]]:
    entries: dict[str, dict[str, object]] = {}
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root).as_posix()
        if relative == "manifest.json" or path.is_dir():
            continue
        mode = path.lstat().st_mode
        if stat.S_ISLNK(mode):
            entries[relative] = {"type": "symlink", "target": os.readlink(path)}
        elif stat.S_ISREG(mode):
            entries[relative] = {"type": "file", "sha256": digest(path), "size": path.stat().st_size}
        else:
            fail(f"unsupported extracted entry: {relative}")
    return entries


def validate_artifact(archive: Path, target_commit: str, expected_tree: str, builder_commit: str,
                      artifact_run_id: str, expected_schema: int) -> dict[str, object]:
    if len(target_commit) != SHA or len(expected_tree) != SHA \
            or any(character not in "0123456789abcdef" for character in target_commit + expected_tree):
        fail("target commit and tree must be full Git SHAs")
    archive_sha = digest(archive)
    with tempfile.TemporaryDirectory(prefix="agent-bridge-offline-") as temporary:
        root = Path(temporary)
        safe_extract(archive, root)
        manifest_path = root / "manifest.json"
        if not manifest_path.is_file() or manifest_path.is_symlink():
            fail("archive must contain a regular manifest.json")
        manifest = json.loads(manifest_path.read_text())
        if manifest.get("commit") != target_commit or manifest.get("tree") != expected_tree:
            fail("manifest target identity mismatch")
        builder = manifest.get("builder")
        if not isinstance(builder, dict) or builder.get("commit") != builder_commit \
                or str(builder.get("workflow_run")) != str(artifact_run_id) \
                or builder.get("workflow_head") != builder_commit:
            fail("manifest builder provenance mismatch")
        if manifest.get("database_schema_version") != expected_schema:
            fail("manifest database schema identity mismatch")
        expected = {entry["path"]: entry for entry in manifest.get("files", [])}
        actual = walk(root)
        if set(expected) != set(actual):
            missing = sorted(set(expected) - set(actual))
            unexpected = sorted(set(actual) - set(expected))
            fail(f"manifest/archive mismatch missing={missing} unexpected={unexpected}")
        for path, entry in expected.items():
            observed = actual[path]
            if entry.get("type", "file") != observed["type"]:
                fail(f"manifest type mismatch: {path}")
            if observed["type"] == "symlink":
                if entry.get("target") != observed["target"]:
                    fail(f"manifest symlink mismatch: {path}")
            elif entry.get("sha256") != observed["sha256"] or entry.get("size") != observed["size"]:
                fail(f"manifest content mismatch: {path}")
        lock_entry = expected.get("package-lock.json")
        if not lock_entry or len(str(lock_entry.get("sha256", ""))) != SHA256:
            fail("manifest package-lock hash is missing")
        return {
            "archive_sha256": archive_sha,
            "commit": target_commit,
            "tree": expected_tree,
            "package_lock_sha256": lock_entry["sha256"],
            "build_strategy": manifest.get("build_strategy"),
            "manifest_files": len(expected),
        }


def snapshot_database(path: Path, expected_schema: int) -> dict[str, object]:
    if path.is_symlink() or not path.is_file():
        fail(f"database fixture must be a regular file: {path}")
    connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
        if integrity != "ok":
            fail(f"integrity check failed for {path}: {integrity}")
        version = int(connection.execute("PRAGMA user_version").fetchone()[0])
        if version > expected_schema:
            fail(f"schema version is newer than target for {path}: {version} > {expected_schema}")
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        required_tables = SCHEMA_TABLES.get(version, CORE_TABLES)
        missing = sorted(required_tables - tables)
        if missing:
            fail(f"database {path} is missing required tables: {missing}")
        snapshots: dict[str, object] = {}
        for table in sorted(required_tables):
            columns = [row[1] for row in connection.execute(f"PRAGMA table_info({table})")]
            count = connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            snapshots[table] = {"columns": columns, "count": count}
        return {
            "path": str(path), "integrity": integrity, "user_version": version,
            "source_schema_version": version, "tables": snapshots,
        }
    finally:
        connection.close()


def _json_value(value: object) -> object:
    if isinstance(value, bytes):
        return {"__bytes__": value.hex()}
    return value


def identity_snapshot(path: Path, columns_by_table: dict[str, list[str]] | None = None) -> dict[str, dict[str, object]]:
    connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        result: dict[str, dict[str, object]] = {}
        table_names = {
            "queue": "pending_messages", "runs": "bridge_runs",
            "events": "bridge_events", "locks": "execution_locks",
        }
        for name, table in table_names.items():
            if table not in tables:
                continue
            metadata = connection.execute(f"PRAGMA table_info({table})").fetchall()
            all_columns = [str(row[1]) for row in metadata]
            columns = (columns_by_table or {}).get(name, all_columns)
            if any(column not in all_columns for column in columns):
                fail(f"identity snapshot requested a missing {name} column")
            primary_key = [str(row[1]) for row in sorted(metadata, key=lambda row: int(row[5])) if int(row[5]) > 0]
            ordering = primary_key or [all_columns[0]]
            rows = [
                {column: _json_value(value) for column, value in zip(columns, row)}
                for row in connection.execute(
                    f"SELECT {', '.join(columns)} FROM {table} ORDER BY {', '.join(ordering)}"
                ).fetchall()
            ]
            canonical = json.dumps(rows, sort_keys=True, separators=(",", ":"))
            result[name] = {
                "columns": columns,
                "row_count": len(rows),
                "sha256": hashlib.sha256(canonical.encode()).hexdigest(),
            }
        return result
    finally:
        connection.close()


def assert_identity_preserved(before: dict[str, dict[str, object]], after: dict[str, dict[str, object]]) -> None:
    for table, expected in before.items():
        observed = after.get(table)
        if observed is None or observed["sha256"] != expected["sha256"]:
            fail(f"queue/run/event/lock identity changed for {table}")


def validate_runtime_root(runtime_root: Path, archive: Path) -> None:
    if runtime_root.is_symlink() or not runtime_root.is_dir():
        fail("migration runtime root must be a regular directory")
    if not (runtime_root / "scripts" / "rollout-db.ts").is_file():
        fail("migration runtime root is missing scripts/rollout-db.ts")
    if not (runtime_root / "package.json").is_file():
        fail("migration runtime root is missing package.json")
    if not (runtime_root / "node_modules" / ".bin" / "tsx").exists():
        fail("migration runtime root requires tsx as a production dependency")
    with tempfile.TemporaryDirectory(prefix="agent-bridge-runtime-verify-") as temporary:
        extracted = Path(temporary)
        safe_extract(archive, extracted)
        if walk(extracted) != walk(runtime_root):
            fail("migration runtime root does not exactly match the verified artifact archive")


def migrate_fixture_copies(databases: list[Path], runtime_root: Path, archive: Path, target_schema: int, source_schema: int) -> dict[str, object]:
    """Migrate only temporary fixture copies using the exact artifact runtime."""
    validate_runtime_root(runtime_root, archive)
    with tempfile.TemporaryDirectory(prefix="agent-bridge-schema-simulation-") as temporary:
        root = Path(temporary)
        working: list[Path] = []
        backups: dict[str, str] = {}
        before_identity: dict[str, dict[str, dict[str, object]]] = {}
        before_columns: dict[str, dict[str, list[str]]] = {}
        for path in databases:
            backup = root / f"{path.name}.backup"
            target = root / path.name
            shutil.copy2(path, backup)
            shutil.copy2(path, target)
            backups[path.name] = digest(backup)
            before_identity[path.name] = identity_snapshot(target)
            before_columns[path.name] = {
                table: list(snapshot["columns"])
                for table, snapshot in before_identity[path.name].items()
            }
            working.append(target)
        command = ["node", "--import", "tsx", "scripts/rollout-db.ts", "migrate", "--evidence", "-"]
        for path in working:
            command.extend(["--db", str(path)])
        completed = subprocess.run(command, cwd=runtime_root, text=True, capture_output=True)
        if completed.returncode != 0:
            fail(f"artifact runtime migration failed: {completed.stderr.strip()}")
        migrated: dict[str, dict[str, object]] = {}
        for path in working:
            current = snapshot_database(path, target_schema)
            current["source_schema_version"] = source_schema
            after_identity = identity_snapshot(path)
            projected_after = identity_snapshot(path, before_columns[path.name])
            assert_identity_preserved(before_identity[path.name], projected_after)
            current["identity_columns"] = after_identity
            current["identity_projected_source_columns"] = projected_after
            migrated[path.name] = current
        restored: dict[str, str] = {}
        for path in working:
            shutil.copy2(root / f"{path.name}.backup", path)
            restored[path.name] = digest(path)
        if backups != restored:
            fail("offline fixture restore was not byte-exact")
        return {
            "databases": list(migrated.values()),
            "queue_claim_run_lock_preserved": True,
            "backup_hashes": backups,
            "restored_hashes": restored,
        }


def simulate_prestart_rollback(databases: list[Path]) -> dict[str, object]:
    """Exercise the pre-start backup/restore boundary using fixture copies only."""
    with tempfile.TemporaryDirectory(prefix="agent-bridge-rollback-simulation-") as temporary:
        root = Path(temporary)
        before = {path.name: digest(path) for path in databases}
        restored: dict[str, str] = {}
        for path in databases:
            working = root / path.name
            backup = root / f"{path.name}.backup"
            shutil.copy2(path, backup)
            shutil.copy2(path, working)
            with working.open("ab") as stream:
                stream.write(b"offline-mutation")
            shutil.copy2(backup, working)
            restored[path.name] = digest(working)
        if before != restored:
            fail("offline pre-start rollback simulation changed a database copy")
        releases = root / "releases"
        releases.mkdir()
        (releases / "previous").mkdir()
        (releases / "target").mkdir()
        current = releases / "current"
        current.symlink_to("previous", target_is_directory=True)
        replacement = releases / ".current.target"
        replacement.symlink_to("target", target_is_directory=True)
        os.replace(replacement, current)
        switched_target = os.readlink(current)
        restoration = releases / ".current.previous"
        restoration.symlink_to("previous", target_is_directory=True)
        os.replace(restoration, current)
        restored_target = os.readlink(current)
        return {
            "state_machine": [
                "PRECHECKED", "BACKUP_VERIFIED", "POINTER_SWITCH_SIMULATED",
                "START_NOT_ATTEMPTED", "DATABASES_RESTORED_FROM_VERIFIED_COPIES",
                "RESTORE_VERIFIED",
            ],
            "database_hashes_before": before,
            "database_hashes_after_restore": restored,
            "pointer_target_after_switch": switched_target,
            "pointer_target_after_restore": restored_target,
            "production_access": False,
        }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--target-commit", required=True)
    parser.add_argument("--expected-tree", required=True)
    parser.add_argument("--builder-commit", required=True)
    parser.add_argument("--artifact-run-id", required=True)
    parser.add_argument("--rollout-helper-sha256", required=True)
    parser.add_argument("--rollout-helper", type=Path, required=True)
    parser.add_argument("--runtime-root", type=Path)
    parser.add_argument("--db-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--expected-schema", type=int, required=True)
    args = parser.parse_args()
    if args.db_root.as_posix().startswith(("/opt/", "/var/", "/etc/")):
        fail("database root looks like a production path; use copied fixtures")
    if len(args.builder_commit) != SHA or any(character not in "0123456789abcdef" for character in args.builder_commit):
        fail("builder identity or rollout-helper hash is malformed")
    if not str(args.artifact_run_id).strip():
        fail("artifact workflow run identity is required")
    if args.rollout_helper.is_symlink() or not args.rollout_helper.is_file():
        fail("rollout helper must be a regular file")
    computed_helper = digest(args.rollout_helper)
    if computed_helper != args.rollout_helper_sha256:
        fail("rollout-helper SHA-256 does not match installed builder bytes")
    databases = sorted(args.db_root.glob("*.sqlite"))
    if not databases:
        fail("--db-root must contain copied .sqlite fixtures")
    artifact_result = validate_artifact(args.archive, args.target_commit, args.expected_tree,
                                        args.builder_commit, args.artifact_run_id, args.expected_schema)
    source_databases = [snapshot_database(path, args.expected_schema) for path in databases]
    source_versions = {int(database["user_version"]) for database in source_databases}
    if len(source_versions) != 1:
        fail(f"copied fixtures do not share one source schema: {sorted(source_versions)}")
    source_schema = next(iter(source_versions))
    migrated = None
    if source_schema < args.expected_schema:
        if args.runtime_root is None:
            fail("schema migration requires --runtime-root containing the exact artifact runtime")
        migrated = migrate_fixture_copies(databases, args.runtime_root, args.archive, args.expected_schema, source_schema)
    result = {
        "schema_version": 1,
        "target_commit": args.target_commit,
        "builder_commit": args.builder_commit,
        "artifact_run_id": str(args.artifact_run_id),
        "expected_schema": args.expected_schema,
        "rollout_helper_sha256": computed_helper,
        "artifact": artifact_result,
        "source_schema_version": source_schema,
        "databases": migrated["databases"] if migrated else source_databases,
        "schema_compatibility": (
            f"migrated copied schema {source_schema} fixtures to target schema {args.expected_schema} with the artifact runtime"
            if migrated else "schema, integrity and required runtime tables verified against copied fixtures"
        ),
        "prestart_rollback_simulation": simulate_prestart_rollback(databases),
        "preservation": migrated or {"queue_claim_run_lock_preserved": True},
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
