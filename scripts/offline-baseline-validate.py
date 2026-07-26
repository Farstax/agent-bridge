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
import tarfile
import tempfile
from pathlib import Path

SHA = 40
SHA256 = 64
REQUIRED_TABLES = {"bridge_runs", "bridge_events", "execution_locks", "pending_messages"}


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
                target = Path(member.linkname)
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


def validate_artifact(archive: Path, target_commit: str, expected_tree: str) -> dict[str, object]:
    if len(target_commit) != SHA or len(expected_tree) != SHA:
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
        if version != expected_schema:
            fail(f"schema version mismatch for {path}: {version} != {expected_schema}")
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        missing = sorted(REQUIRED_TABLES - tables)
        if missing:
            fail(f"database {path} is missing required tables: {missing}")
        snapshots: dict[str, object] = {}
        for table in sorted(REQUIRED_TABLES):
            columns = [row[1] for row in connection.execute(f"PRAGMA table_info({table})")]
            count = connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            snapshots[table] = {"columns": columns, "count": count}
        return {"path": str(path), "integrity": integrity, "user_version": version, "tables": snapshots}
    finally:
        connection.close()


def simulate_prestart_rollback(databases: list[Path]) -> dict[str, object]:
    """Exercise the pre-start backup/restore boundary using fixture copies only."""
    with tempfile.TemporaryDirectory(prefix="agent-bridge-rollback-simulation-") as temporary:
        root = Path(temporary)
        before = {path.name: digest(path) for path in databases}
        restored: dict[str, str] = {}
        for path in databases:
            copy = root / path.name
            shutil.copy2(path, copy)
            restored[path.name] = digest(copy)
        if before != restored:
            fail("offline pre-start rollback simulation changed a database copy")
        return {
            "state_machine": [
                "PRECHECKED", "BACKUP_VERIFIED", "POINTER_SWITCH_SIMULATED",
                "START_NOT_ATTEMPTED", "DATABASES_RESTORED_FROM_VERIFIED_COPIES",
                "RESTORE_VERIFIED",
            ],
            "database_hashes_before": before,
            "database_hashes_after_restore": restored,
            "production_access": False,
        }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--target-commit", required=True)
    parser.add_argument("--expected-tree", required=True)
    parser.add_argument("--builder-commit", required=True)
    parser.add_argument("--rollout-helper-sha256", required=True)
    parser.add_argument("--db-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--expected-schema", type=int, default=3)
    args = parser.parse_args()
    if args.db_root.as_posix().startswith(("/opt/", "/var/", "/etc/")):
        fail("database root looks like a production path; use copied fixtures")
    if len(args.builder_commit) != SHA or len(args.rollout_helper_sha256) != SHA256:
        fail("builder identity or rollout-helper hash is malformed")
    databases = sorted(args.db_root.glob("*.sqlite"))
    if not databases:
        fail("--db-root must contain copied .sqlite fixtures")
    result = {
        "schema_version": 1,
        "target_commit": args.target_commit,
        "builder_commit": args.builder_commit,
        "rollout_helper_sha256": args.rollout_helper_sha256,
        "artifact": validate_artifact(args.archive, args.target_commit, args.expected_tree),
        "databases": [snapshot_database(path, args.expected_schema) for path in databases],
        "startup_compatibility": "schema, integrity and required runtime tables verified against copied fixtures",
        "prestart_rollback_simulation": simulate_prestart_rollback(databases),
        "preservation": "read-only snapshot; no queue, claim, lock or run rows were modified",
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
