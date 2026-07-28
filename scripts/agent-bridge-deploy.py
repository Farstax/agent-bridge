#!/usr/bin/env python3
"""The single public Agent Bridge deployment command."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

_STAGE_SPEC = importlib.util.spec_from_file_location("agent_bridge_release_stage", Path(__file__).with_name("release-stage.py"))
if _STAGE_SPEC is None or _STAGE_SPEC.loader is None:
    raise RuntimeError("private release staging primitive is unavailable")
_STAGE = importlib.util.module_from_spec(_STAGE_SPEC)
_STAGE_SPEC.loader.exec_module(_STAGE)
extract_archive = _STAGE.extract_archive
load_manifest = _STAGE.load_manifest
verify_manifest = _STAGE.verify_manifest

SHA = re.compile(r"^[0-9a-f]{40}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
TOKEN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$")


def fail(message: str) -> None:
    raise RuntimeError(message)


def digest(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def secure_file(path: Path, production: bool) -> bytes:
    if path.is_symlink() or not path.is_file():
        fail(f"{path} must be a regular non-symlink file")
    metadata = path.stat()
    if metadata.st_mode & 0o077:
        fail(f"{path} must not be group/world accessible")
    if production and metadata.st_uid != 0:
        fail(f"{path} must be root-owned")
    return path.read_bytes()


def parse_approval(path: Path, expected_commit: str, release_sha256: str, now: datetime, production: bool) -> dict:
    try:
        document = json.loads(secure_file(path, production).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"invalid deployment approval: {error}")
    required = ("environment", "target_commit", "release_sha256", "approval_reference", "expires_at")
    if not isinstance(document, dict) or set(document) != set(required) or any(not isinstance(document.get(key), str) or not document[key] for key in required):
        fail("approval requires environment, target_commit, release_sha256, approval_reference and expires_at")
    if not TOKEN.fullmatch(document["environment"]) or not TOKEN.fullmatch(document["approval_reference"]):
        fail("approval contains an invalid environment or reference")
    if not SHA.fullmatch(document["target_commit"]) or document["target_commit"] != expected_commit:
        fail("approval target commit does not match the release manifest")
    if not SHA256.fullmatch(document["release_sha256"]) or document["release_sha256"] != release_sha256:
        fail("approval release SHA-256 does not match the supplied archive")
    try:
        expires = datetime.fromisoformat(document["expires_at"].replace("Z", "+00:00"))
    except ValueError as error:
        fail(f"approval expiry is invalid: {error}")
    if expires.tzinfo != timezone.utc or expires <= now:
        fail("approval is expired")
    return document


def validate_archive(archive: Path, approval: Path, now: datetime, production: bool) -> tuple[str, str, dict]:
    if archive.is_symlink() or not archive.is_file() or archive.resolve() != archive:
        fail("release archive must be a canonical regular file")
    release_sha256 = digest(archive)
    with tempfile.TemporaryDirectory(prefix="agent-bridge-deploy-validate-") as directory:
        root = Path(directory)
        try:
            with archive.open("rb") as stream:
                extract_archive(stream, root)
            manifest = load_manifest(root)
            verify_manifest(root, manifest)
        except Exception as error:
            fail(f"release archive or manifest validation failed: {error}")
        if not SHA.fullmatch(manifest["commit"]):
            fail("release manifest commit is invalid")
        qualification = root / "qualification-evidence.json"
        if production and (not qualification.is_file() or qualification.is_symlink()):
            fail("release archive must contain embedded qualification-evidence.json")
        if qualification.is_file() and not qualification.is_symlink():
            try:
                qualification_document = json.loads(qualification.read_text(encoding="utf-8"))
            except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
                fail(f"embedded qualification evidence is invalid: {error}")
            if qualification_document.get("commit") != manifest["commit"] or qualification_document.get("tree") != manifest["tree"]:
                fail("embedded qualification evidence does not match the release manifest")
    approval_document = parse_approval(Path(approval), manifest["commit"], release_sha256, now, production)
    return manifest["commit"], release_sha256, approval_document


def configured_value(config: Path, name: str) -> str:
    for line in config.read_text(encoding="utf-8").splitlines():
        key, separator, value = line.partition("=")
        if separator and key == name:
            return value
    fail(f"private rollout configuration is missing {name}")


def run_deployment(archive: Path, approval: Path) -> str:
    production = os.environ.get("AGENT_BRIDGE_DEPLOY_TEST") != "1"
    commit, archive_sha256, _ = validate_archive(archive, approval, datetime.now(timezone.utc), production)
    if os.environ.get("AGENT_BRIDGE_DEPLOY_VALIDATE_ONLY") == "1":
        return f"validated {commit} {archive_sha256}"
    if not production:
        release_root_value = os.environ.get("AGENT_BRIDGE_DEPLOY_TEST_RELEASE_ROOT", "")
        if release_root_value:
            release_root = Path(release_root_value)
            stage = Path(__file__).with_name("release-stage.py")
            environment = {**os.environ, "AGENT_BRIDGE_RELEASE_STAGE_TEST": "1"}
            subprocess.run([
                sys.executable, str(stage), "--archive", str(archive),
                "--release-root", str(release_root), "--expected-commit", commit,
                "--archive-sha256", archive_sha256,
            ], check=True, env=environment)
            return f"deployed {commit} {archive_sha256}"
        return f"validated {commit} {archive_sha256}"
    if os.geteuid() != 0:
        fail("agent-bridge-deploy must run as root")
    config = Path("/etc/agent-bridge/rollout.conf")
    release_root = Path(configured_value(config, "release_root"))
    staging_helper = Path("/usr/local/libexec/agent-bridge-release-stage")
    rollout_helper = Path("/usr/local/sbin/rollout-agent-bridge")
    subprocess.run([
        "/usr/bin/python3", str(staging_helper), "--archive", str(archive),
        "--release-root", str(release_root), "--expected-commit", commit,
        "--archive-sha256", archive_sha256,
    ], check=True)
    environment = os.environ.copy()
    environment["AGENT_BRIDGE_DEPLOYER_MODE"] = "1"
    subprocess.run([str(rollout_helper), "--expected-commit", commit], check=True, env=environment)
    return f"deployed {commit} {archive_sha256}"


def main() -> int:
    parser = argparse.ArgumentParser(prog="agent-bridge-deploy")
    parser.add_argument("--release", type=Path, required=True)
    parser.add_argument("--approval", type=Path, required=True)
    parser.add_argument("--validate-only", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.validate_only:
        os.environ["AGENT_BRIDGE_DEPLOY_VALIDATE_ONLY"] = "1"
    print(run_deployment(args.release, args.approval))
    return 0


if __name__ == "__main__":
    script_directory = str(Path(__file__).resolve().parent)
    if script_directory not in sys.path:
        sys.path.insert(0, script_directory)
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"agent-bridge-deploy: {error}", file=sys.stderr)
        raise SystemExit(1)
