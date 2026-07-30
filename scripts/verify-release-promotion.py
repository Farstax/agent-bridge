#!/usr/bin/env python3
"""Verify an Agent Bridge CI artifact before GitHub Release publication."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import tarfile
from pathlib import Path, PurePosixPath
from typing import Any

GIT_SHA = re.compile(r"^[0-9a-f]{40}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
WORKFLOW_RUN = re.compile(r"^[1-9][0-9]*$")
REQUIRED_CHECKS = {"test", "typecheck", "architecture-lint", "compile", "manifest"}


class VerificationError(RuntimeError):
    pass


def fail(message: str) -> None:
    raise VerificationError(message)


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def member_path(raw: str) -> str | None:
    if not raw or "\x00" in raw or raw.startswith("/"):
        fail(f"archive contains unsafe member path: {raw!r}")
    parts: list[str] = []
    for part in PurePosixPath(raw).parts:
        if part in ("", "."):
            continue
        if part == "..":
            fail(f"archive member escapes root: {raw}")
        parts.append(part)
    return "/".join(parts) if parts else None


def validate_symlink_target(path: str, target: str) -> None:
    if not target or "\x00" in target or target.startswith("/"):
        fail(f"archive symlink has unsafe target: {path} -> {target!r}")
    stack = path.split("/")[:-1]
    for part in PurePosixPath(target).parts:
        if part in ("", "."):
            continue
        if part == "..":
            if not stack:
                fail(f"archive symlink escapes root: {path} -> {target}")
            stack.pop()
        else:
            stack.append(part)


def validate_hardlink_target(path: str, target: str) -> None:
    normalized = member_path(target)
    if normalized is None:
        fail(f"archive hardlink has unsafe target: {path} -> {target!r}")


def read_json_member(archive: tarfile.TarFile, member: tarfile.TarInfo, name: str) -> dict[str, Any]:
    extracted = archive.extractfile(member)
    if extracted is None:
        fail(f"archive member is not readable: {name}")
    try:
        value = json.loads(extracted.read().decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"archive contains invalid {name}: {error}")
    if not isinstance(value, dict):
        fail(f"archive {name} must be a JSON object")
    return value


def require_git_sha(value: Any, label: str) -> str:
    if not isinstance(value, str) or not GIT_SHA.fullmatch(value):
        fail(f"{label} must be a full lowercase 40-character Git SHA")
    return value


def require_workflow_run(value: Any, label: str) -> str:
    text = str(value)
    if not WORKFLOW_RUN.fullmatch(text):
        fail(f"{label} must be a positive numeric workflow run ID")
    return text


def verify_manifest(
    archive: tarfile.TarFile,
    members: dict[str, tarfile.TarInfo],
    manifest: dict[str, Any],
    evidence: dict[str, Any],
    expected_commit: str,
    expected_workflow_run: str,
) -> tuple[str, int]:
    if manifest.get("schema_version") != 1:
        fail("manifest schema version is unsupported")
    if manifest.get("commit") != expected_commit:
        fail("manifest commit does not match")
    tree = require_git_sha(manifest.get("tree"), "manifest tree")

    builder = manifest.get("builder")
    if not isinstance(builder, dict):
        fail("manifest builder provenance is missing")
    if builder.get("commit") != expected_commit or builder.get("workflow_head") != expected_commit:
        fail("manifest builder commit does not match")
    if require_workflow_run(builder.get("workflow_run"), "manifest builder workflow run") != expected_workflow_run:
        fail("manifest builder workflow run does not match")

    runtime = manifest.get("runtime")
    if not isinstance(runtime, dict) or runtime.get("platform") != "linux" or runtime.get("arch") != "x64":
        fail("manifest runtime must be linux/x64")

    if evidence.get("commit") != expected_commit or evidence.get("workflow_head") != expected_commit:
        fail("qualification evidence commit does not match")
    if evidence.get("tree") != tree:
        fail("qualification evidence tree does not match manifest")
    if require_workflow_run(evidence.get("workflow_run"), "qualification workflow run") != expected_workflow_run:
        fail("qualification workflow run does not match")
    checks = evidence.get("checks")
    if not isinstance(checks, list) or not REQUIRED_CHECKS.issubset(set(checks)):
        fail("qualification evidence is missing required checks")

    raw_files = manifest.get("files")
    if not isinstance(raw_files, list) or not raw_files:
        fail("manifest files list is missing")

    declared: dict[str, dict[str, Any]] = {}
    for raw_entry in raw_files:
        if not isinstance(raw_entry, dict):
            fail("manifest file entry must be an object")
        raw_path = raw_entry.get("path")
        if not isinstance(raw_path, str) or member_path(raw_path) != raw_path:
            fail(f"manifest contains unsafe file path: {raw_path!r}")
        if raw_path == "manifest.json" or raw_path in declared:
            fail(f"manifest contains duplicate or reserved file path: {raw_path}")
        declared[raw_path] = raw_entry

    payload_members = set(members) - {"manifest.json"}
    missing = sorted(set(declared) - payload_members)
    if missing:
        fail(f"manifest declares missing member: {missing[0]}")
    undeclared = sorted(payload_members - set(declared))
    if undeclared:
        fail(f"archive contains undeclared member: {undeclared[0]}")

    for path, entry in declared.items():
        member = members[path]
        if entry.get("type") == "symlink":
            if not member.issym() or member.linkname != entry.get("target"):
                fail(f"manifest symlink does not match archive: {path}")
            validate_symlink_target(path, member.linkname)
            continue

        if not (member.isreg() or member.islnk()):
            fail(f"manifest regular file has unsupported archive type: {path}")
        expected_hash = entry.get("sha256")
        expected_size = entry.get("size")
        if not isinstance(expected_hash, str) or not SHA256.fullmatch(expected_hash):
            fail(f"manifest file hash is invalid: {path}")
        if not isinstance(expected_size, int) or expected_size < 0:
            fail(f"manifest file size is invalid: {path}")
        extracted = archive.extractfile(member)
        if extracted is None:
            fail(f"archive file is not readable: {path}")
        data = extracted.read()
        if len(data) != expected_size:
            fail(f"manifest file size does not match archive: {path}")
        if hashlib.sha256(data).hexdigest() != expected_hash:
            fail(f"manifest file hash does not match archive: {path}")

    package_lock = declared.get("package-lock.json")
    if package_lock is None or manifest.get("package_lock_sha256") != package_lock.get("sha256"):
        fail("manifest package-lock identity does not match")

    return tree, len(declared)


def verify(artifact_dir: Path, commit: str, workflow_run: str) -> dict[str, Any]:
    if not GIT_SHA.fullmatch(commit):
        fail("commit must be a full lowercase 40-character Git SHA")
    if not WORKFLOW_RUN.fullmatch(workflow_run):
        fail("workflow run must be a positive numeric ID")
    if not artifact_dir.is_dir():
        fail("artifact directory does not exist")

    archive_name = f"agent-bridge-{commit}.tar.gz"
    checksum_name = f"{archive_name}.sha256"
    entries = sorted(artifact_dir.iterdir(), key=lambda path: path.name)
    if [path.name for path in entries] != [archive_name, checksum_name]:
        fail("artifact directory must contain exactly the expected archive and checksum")
    if any(path.is_symlink() or not path.is_file() for path in entries):
        fail("release artifact files must be regular files")

    archive_path = artifact_dir / archive_name
    checksum_path = artifact_dir / checksum_name
    checksum_line = checksum_path.read_text(encoding="utf-8")
    checksum_match = re.fullmatch(rf"([0-9a-f]{{64}})  {re.escape(archive_name)}\n?", checksum_line)
    if checksum_match is None:
        fail("checksum file must contain the exact archive name and SHA-256")
    archive_sha256 = file_sha256(archive_path)
    if checksum_match.group(1) != archive_sha256:
        fail("archive checksum does not match")

    try:
        with tarfile.open(archive_path, mode="r:gz") as archive:
            members: dict[str, tarfile.TarInfo] = {}
            for member in archive.getmembers():
                path = member_path(member.name)
                if path is None or member.isdir():
                    continue
                if path in members:
                    fail(f"archive contains duplicate member: {path}")
                if member.issym():
                    validate_symlink_target(path, member.linkname)
                elif member.islnk():
                    validate_hardlink_target(path, member.linkname)
                elif not member.isreg():
                    fail(f"archive contains unsupported member type: {path}")
                members[path] = member

            manifest_member = members.get("manifest.json")
            evidence_member = members.get("qualification-evidence.json")
            if manifest_member is None or not manifest_member.isreg():
                fail("archive is missing regular manifest.json")
            if evidence_member is None or not evidence_member.isreg():
                fail("archive is missing regular qualification-evidence.json")
            manifest = read_json_member(archive, manifest_member, "manifest.json")
            evidence = read_json_member(archive, evidence_member, "qualification-evidence.json")
            tree, file_count = verify_manifest(
                archive,
                members,
                manifest,
                evidence,
                commit,
                workflow_run,
            )
    except (tarfile.TarError, OSError) as error:
        fail(f"release archive is unreadable: {error}")

    return {
        "archive": archive_name,
        "archive_sha256": archive_sha256,
        "checksum": checksum_name,
        "commit": commit,
        "file_count": file_count,
        "tree": tree,
        "workflow_run": workflow_run,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifact-dir", required=True, type=Path)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--workflow-run", required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        report = verify(args.artifact_dir, args.commit, args.workflow_run)
    except VerificationError as error:
        print(f"release promotion verification failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(report, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
