#!/usr/bin/env python3
"""Atomically activate one previously staged immutable release.

This helper publishes the ``current`` symlink after validating the release and
converging release-owned host components. It does not stop or start services or
modify databases. The caller owns the guarded service/database state machine
and must hold its rollout lock.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path


SHA = 40


def fail(message: str) -> None:
    raise RuntimeError(message)


def production_mode() -> bool:
    return os.environ.get("AGENT_BRIDGE_RELEASE_ACTIVATE_TEST") != "1"


def validate_commit(commit: str) -> None:
    if len(commit) != SHA or any(char not in "0123456789abcdef" for char in commit):
        fail("expected commit must be a full lowercase 40-character SHA")


def validate_release_root(path: Path) -> Path:
    if path.is_symlink() or not path.is_dir():
        fail("release root must be a regular directory, not a symlink")
    metadata = path.stat()
    if production_mode() and (metadata.st_uid != 0 or metadata.st_mode & 0o022):
        fail("production release root must be root-owned and not group/world writable")
    return path


def _regular(path: Path) -> bool:
    return path.is_file() and not path.is_symlink()


def _manifest_files(release: Path, manifest: dict) -> None:
    entries = manifest.get("files")
    if not isinstance(entries, list):
        fail("strict release manifest must contain files")
    expected: dict[str, dict] = {}
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get("path"), str):
            fail("release manifest contains an invalid file entry")
        relative = entry["path"]
        candidate = (release / relative).resolve()
        if Path(relative).is_absolute() or candidate != release and release not in candidate.parents:
            fail(f"release manifest contains an unsafe path: {relative}")
        if relative in expected:
            fail(f"release manifest contains a duplicate path: {relative}")
        expected[relative] = entry
    actual: dict[str, Path] = {}
    for current, directories, files in os.walk(release, followlinks=False):
        for name in files:
            path = Path(current) / name
            if path == release / "manifest.json":
                continue
            actual[str(path.relative_to(release))] = path
        for name in directories:
            path = Path(current) / name
            if path.is_symlink():
                actual[str(path.relative_to(release))] = path
    if set(actual) != set(expected):
        fail("release manifest paths do not match the archived filesystem")
    package_lock = expected.get("package-lock.json")
    if package_lock and manifest.get("package_lock_sha256") != package_lock.get("sha256"):
        fail("release manifest package-lock hash does not match its file entry")
    for relative, path in actual.items():
        entry = expected[relative]
        kind = "symlink" if path.is_symlink() else "file" if path.is_file() else "directory" if path.is_dir() else "other"
        if entry.get("type", "file") != kind:
            fail(f"release manifest type mismatch: {relative}")
        if kind == "file":
            if entry.get("sha256") != hashlib.sha256(path.read_bytes()).hexdigest():
                fail(f"release manifest hash mismatch: {relative}")
            if entry.get("size") != path.stat().st_size:
                fail(f"release manifest size mismatch: {relative}")
        if kind == "symlink" and entry.get("target") != os.readlink(path):
            fail(f"release manifest symlink mismatch: {relative}")


def validate_release(release: Path, expected_commit: str, strict: bool = False) -> None:
    if release.is_symlink() or not release.is_dir():
        fail("target release must be an immutable regular directory")
    manifest_path = release / "manifest.json"
    if manifest_path.is_symlink() or not manifest_path.is_file():
        fail("target release is missing a regular manifest.json")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        fail(f"invalid target release manifest: {error}")
    if manifest.get("schema_version") != 1 or manifest.get("commit") != expected_commit:
        fail("target release manifest identity does not match expected commit")
    if strict:
        _manifest_files(release, manifest)
        required = ("scripts/rollout-db.ts", "scripts/rollout-db-impl.ts")
        if any(not _regular(release / path) for path in required):
            fail("release runtime contract is missing a required regular helper")
        strategy = manifest.get("build_strategy", "source-tsx")
        if strategy == "source-tsx":
            for path in ("tsconfig.json", "node_modules/tsx/dist/cli.mjs", "src/index.ts", "src/index-interactive.ts", "src/index-discord-interactive.ts", "src/index-health.ts"):
                if not _regular(release / path):
                    fail(f"source-tsx runtime contract requires regular file: {path}")

    for current, directories, files in os.walk(release, followlinks=False):
        for name in directories + files:
            path = Path(current) / name
            if path.is_symlink():
                target = os.readlink(path)
                if os.path.isabs(target) or (path.parent / target).resolve() != release and release not in (path.parent / target).resolve().parents:
                    fail(f"target release contains an escaping symlink: {path}")
                continue
            mode = path.stat().st_mode
            if mode & 0o222:
                fail(f"target release is writable: {path}")
    if release.stat().st_mode & 0o222:
        fail("target release directory is writable")


def converge_release_host_components(release: Path) -> None:
    """Converge optional components owned by this release before pointer switch.

    Older releases intentionally lack the voice component installer; skipping it
    keeps rollback to those releases possible. A release that ships the helper
    owns the complete pinned STT contract and activation fails closed if that
    convergence or its smoke test fails.
    """
    if not production_mode():
        return
    voice_installer = release / "scripts" / "install-voice-stt.sh"
    if not voice_installer.exists():
        return
    if not _regular(voice_installer):
        fail("voice STT installer must be a regular release file")
    try:
        subprocess.run(["/bin/bash", str(voice_installer)], check=True)
    except subprocess.CalledProcessError as error:
        fail(f"voice STT convergence failed with exit {error.returncode}")


def current_target(current: Path, release_root: Path) -> str | None:
    if not current.exists() and not current.is_symlink():
        return None
    if not current.is_symlink():
        fail("current pointer must be a symlink or absent")
    target = os.readlink(current)
    if os.path.isabs(target) or Path(target).name != target:
        fail("current pointer target must be a relative release name")
    previous = release_root / target
    if target == "current" or previous.is_symlink() or not previous.is_dir():
        fail("current pointer does not resolve to a release directory")
    return target


def activate(release_root: Path, current: Path, expected_commit: str) -> str:
    validate_commit(expected_commit)
    release_root = validate_release_root(release_root)
    if current.parent != release_root or current.name != "current":
        fail("current pointer must be release-root/current")
    release = release_root / expected_commit
    validate_release(release, expected_commit)
    previous = current_target(current, release_root)
    if previous == expected_commit:
        fail("same target pointer is a no-op activation; refusing POINTER_SWITCHED")

    # Host convergence belongs before the immutable release becomes active.
    # This makes first install and later upgrades share the same fail-closed
    # component contract while retaining the old release/component for rollback.
    converge_release_host_components(release)

    descriptor, temporary_name = tempfile.mkstemp(prefix=".current-", dir=release_root)
    os.close(descriptor)
    temporary = Path(temporary_name)
    temporary.unlink()
    try:
        os.symlink(expected_commit, temporary)
        os.replace(temporary, current)
    finally:
        if temporary.is_symlink() or temporary.exists():
            temporary.unlink()
    if previous:
        return f"activated {expected_commit} (previous {previous})"
    return f"activated {expected_commit} (previous none)"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--release-root", type=Path, required=True)
    parser.add_argument("--current", type=Path, required=True)
    parser.add_argument("--expected-commit", required=True)
    parser.add_argument("--validate-only", action="store_true")
    args = parser.parse_args()
    if os.geteuid() != 0 and production_mode():
        fail("release activation must run as root")
    validate_release_root(args.release_root)
    validate_release(args.release_root / args.expected_commit, args.expected_commit, strict=args.validate_only or production_mode())
    if args.validate_only:
        print(f"validated {args.expected_commit}")
    else:
        print(activate(args.release_root, args.current, args.expected_commit))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"release-activate: {error}", file=sys.stderr)
        raise SystemExit(1)
