#!/usr/bin/env python3
"""The single public Agent Bridge deployment command."""

from __future__ import annotations

import argparse
import hashlib
import importlib.machinery
import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

SHA = re.compile(r"^[0-9a-f]{40}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
TOKEN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$")
USERNAME = re.compile(r"^[a-z_][a-z0-9_-]*[$]?$")
REPOSITORY = "nickconstantinou/agent-bridge"
REPOSITORY_OWNER = "nickconstantinou"
DEPLOY_UNIT = re.compile(r"^agent-bridge-deploy-[1-9][0-9]*\.service$")
DEPLOY_UNIT_ENV = "AGENT_BRIDGE_DEPLOY_UNIT"
SYSTEMD_RUN = "/usr/bin/systemd-run"
RUNUSER = "/usr/sbin/runuser"
SUDO = "/usr/bin/sudo"
SUDO_CHECK_TIMEOUT_SECONDS = 5


def staging_module(helper: Path):
    loader = importlib.machinery.SourceFileLoader("agent_bridge_release_stage", str(helper))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    if spec is None:
        fail(f"private release staging primitive is unavailable: {helper}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def fail(message: str) -> None:
    raise RuntimeError(message)


def parse_utc_timestamp(value: object, field: str) -> datetime:
    if not isinstance(value, str) or not value.endswith("Z"):
        fail(f"owner deployment request {field} must be an ISO-8601 UTC timestamp")
    try:
        parsed = datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError as error:
        fail(f"owner deployment request {field} is invalid: {error}")
    if parsed.tzinfo != timezone.utc:
        fail(f"owner deployment request {field} must use UTC")
    return parsed


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


def parse_approval(path: Path, expected_commit: str, release_sha256: str, now: datetime, production: bool, fixed_environment: str | None = None) -> dict:
    try:
        document = json.loads(secure_file(path, production).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"invalid deployment approval: {error}")
    required = ("environment", "target_commit", "release_sha256", "approval_reference", "expires_at")
    if not isinstance(document, dict) or set(document) != set(required) or any(not isinstance(document.get(key), str) or not document[key] for key in required):
        fail("approval requires environment, target_commit, release_sha256, approval_reference and expires_at")
    if not TOKEN.fullmatch(document["environment"]) or not TOKEN.fullmatch(document["approval_reference"]):
        fail("approval contains an invalid environment or reference")
    if fixed_environment is not None and document["environment"] != fixed_environment:
        fail("approval environment does not match the fixed deployment environment")
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


def validate_archive(archive: Path, approval: Path | None, now: datetime, production: bool, fixed_environment: str | None = None, stage_helper: Path | None = None) -> tuple[str, str, dict | None]:
    if archive.is_symlink() or not archive.is_file():
        fail("release archive must be a regular non-symlink file")
    release_sha256 = digest(archive)
    with tempfile.TemporaryDirectory(prefix="agent-bridge-deploy-validate-") as directory:
        root = Path(directory)
        try:
            stage = staging_module(stage_helper or Path(__file__).with_name("release-stage.py"))
            with archive.open("rb") as stream:
                stage.extract_archive(stream, root)
            manifest = stage.load_manifest(root)
            stage.verify_manifest(root, manifest)
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
    approval_document = parse_approval(Path(approval), manifest["commit"], release_sha256, now, production, fixed_environment) if approval else None
    return manifest["commit"], release_sha256, approval_document


def parse_owner_request(path: Path, expected_commit: str, now: datetime, production: bool) -> dict:
    try:
        document = json.loads(secure_file(path, production).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"invalid owner deployment request: {error}")
    required = ("repository", "owner", "authenticated", "reference", "requested_at", "expires_at", "target_commit")
    if not isinstance(document, dict) or set(document) != set(required):
        fail("owner deployment request has an invalid shape")
    if document["repository"] != REPOSITORY or document["owner"] != REPOSITORY_OWNER:
        fail("owner deployment request is for a different repository owner")
    if document["authenticated"] is not True:
        fail("owner deployment request is not authenticated")
    if not TOKEN.fullmatch(document["reference"]):
        fail("owner deployment request reference is invalid")
    if not SHA.fullmatch(document["target_commit"]) or document["target_commit"] != expected_commit:
        fail("owner deployment request target commit does not match the release manifest")
    requested_at = parse_utc_timestamp(document["requested_at"], "requested_at")
    expires_at = parse_utc_timestamp(document["expires_at"], "expires_at")
    if expires_at <= requested_at or requested_at > now or expires_at <= now:
        fail("owner deployment request is expired or not yet valid")
    return document


def materialize_owner_approval(owner_request: dict, commit: str, release_sha256: str, environment: str, directory: Path) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    output = directory / f"deployment-authorization-{commit}.json"
    document = {
        "environment": environment,
        "target_commit": commit,
        "release_sha256": release_sha256,
        "approval_reference": owner_request["reference"],
        "expires_at": owner_request["expires_at"],
    }
    content = (json.dumps(document, sort_keys=True) + "\n").encode("utf-8")
    if output.exists():
        if output.is_symlink() or output.read_bytes() != content:
            fail(f"owner authorization already exists with different content: {output}")
        return output
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    descriptor = os.open(output, flags, 0o600)
    try:
        os.write(descriptor, content)
    finally:
        os.close(descriptor)
    return output


def configured_value(config: Path, name: str) -> str:
    for line in config.read_text(encoding="utf-8").splitlines():
        key, separator, value = line.partition("=")
        if separator and key == name:
            return value
    fail(f"private rollout configuration is missing {name}")


def verify_runtime_sudo(config: Path) -> None:
    runtime_user = configured_value(config, "runtime_user")
    if not USERNAME.fullmatch(runtime_user):
        fail("invalid runtime user in private rollout configuration")
    try:
        result = subprocess.run(
            [RUNUSER, "--user", runtime_user, "--", SUDO, "-k", "-n", "true"],
            check=False,
            capture_output=True,
            text=True,
            timeout=SUDO_CHECK_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        fail("passwordless sudo verification timed out for the runtime account")
    except OSError as error:
        fail(f"passwordless sudo verification could not run: {error}")
    if result.returncode != 0:
        diagnostic = (result.stderr or "").strip()
        suffix = f": {diagnostic}" if diagnostic else ""
        fail(f"passwordless sudo check failed for the runtime account{suffix}")


def validate_private_file(path: Path, executable: bool) -> None:
    if path.is_symlink() or not path.is_file():
        fail(f"private deployer file is unavailable: {path}")
    metadata = path.stat()
    if metadata.st_uid != 0 or metadata.st_mode & 0o022:
        fail(f"private deployer file must be root-owned and non-writable: {path}")
    if executable and not metadata.st_mode & 0o111:
        fail(f"private deployer helper is not executable: {path}")


def validate_private_helper(path: Path) -> None:
    validate_private_file(path, True)


def reject_root_test_overrides() -> None:
    test_override_keys = sorted(key for key in os.environ if key.startswith("AGENT_BRIDGE_DEPLOY_TEST"))
    if os.geteuid() == 0 and test_override_keys:
        fail(f"test overrides are forbidden for root deployment: {', '.join(test_override_keys)}")


def absolute_input(path: Path) -> Path:
    return Path(os.path.abspath(os.fspath(path)))


def current_cgroup_has_unit(unit: str, cgroup_text: str | None = None) -> bool:
    if not DEPLOY_UNIT.fullmatch(unit):
        return False
    try:
        text = cgroup_text if cgroup_text is not None else Path("/proc/self/cgroup").read_text(encoding="utf-8")
    except OSError:
        return False
    for line in text.splitlines():
        cgroup_path = line.split(":", 2)[-1]
        if unit in cgroup_path.split("/"):
            return True
    return False


def detached_command(release: Path, approval: Path | None, owner_request: Path | None, unit: str, script: Path | None = None) -> list[str]:
    if not DEPLOY_UNIT.fullmatch(unit):
        fail("invalid transient deployment unit")
    command = [
        SYSTEMD_RUN,
        "--system",
        f"--unit={unit}",
        "--collect",
        "--wait",
        "--quiet",
        "--service-type=exec",
        "--property=KillMode=control-group",
        f"--setenv={DEPLOY_UNIT_ENV}={unit}",
        "/usr/bin/python3",
        str(script or Path(__file__).resolve()),
        "--internal-worker",
        "--release",
        str(absolute_input(release)),
    ]
    if approval:
        command.extend(["--approval", str(absolute_input(approval))])
    if owner_request:
        command.extend(["--owner-request", str(absolute_input(owner_request))])
    return command


def launch_detached(release: Path, approval: Path | None, owner_request: Path | None) -> int:
    unit = f"agent-bridge-deploy-{os.getpid()}.service"
    print(f"deployment continuing in transient unit {unit}", flush=True)
    result = subprocess.run(detached_command(release, approval, owner_request, unit), check=False)
    return result.returncode


def run_deployment(archive: Path, approval: Path | None, owner_request: Path | None = None) -> str:
    reject_root_test_overrides()
    production = os.geteuid() == 0 or os.environ.get("AGENT_BRIDGE_DEPLOY_TEST") != "1"
    config = Path("/etc/agent-bridge/rollout.conf") if production else None
    stage_helper = Path("/usr/local/libexec/agent-bridge-release-stage") if production else Path(os.environ.get("AGENT_BRIDGE_DEPLOY_TEST_STAGE_HELPER", Path(__file__).with_name("release-stage.py")))
    if production:
        assert config is not None
        validate_private_file(config, False)
        for private_file in (
            stage_helper,
            Path("/usr/local/sbin/rollout-agent-bridge"),
            Path("/usr/local/libexec/agent-bridge-release-activate"),
            Path("/usr/local/libexec/agent-bridge-rollout-restore"),
            Path("/usr/local/libexec/agent-bridge-rollout-authorization.py"),
            Path("/usr/local/libexec/agent-bridge-rollout-acceptance.py"),
        ):
            validate_private_helper(private_file)
        verify_runtime_sudo(config)
    fixed_environment = configured_value(config, "environment") if config else os.environ.get("AGENT_BRIDGE_DEPLOY_TEST_ENVIRONMENT")
    if owner_request:
        commit, archive_sha256, _ = validate_archive(archive, None, datetime.now(timezone.utc), production, fixed_environment, stage_helper)
        request = parse_owner_request(Path(owner_request), commit, datetime.now(timezone.utc), production)
        authorization_dir = Path("/etc/agent-bridge") if production else Path(os.environ.get("AGENT_BRIDGE_DEPLOY_TEST_AUTHORIZATION_DIR", Path(owner_request).parent))
        approval = materialize_owner_approval(request, commit, archive_sha256, fixed_environment or "production-content-crawler", authorization_dir)
    commit, archive_sha256, approval_document = validate_archive(archive, approval, datetime.now(timezone.utc), production, fixed_environment, stage_helper)
    if approval_document is None:
        approval_document = {
            "environment": fixed_environment or "production-content-crawler",
            "target_commit": commit,
            "release_sha256": archive_sha256,
            "approval_reference": "direct-operator-instruction",
        }
    if os.environ.get("AGENT_BRIDGE_DEPLOY_VALIDATE_ONLY") == "1":
        return f"validated {commit} {archive_sha256}"
    if not production:
        release_root_value = os.environ.get("AGENT_BRIDGE_DEPLOY_TEST_RELEASE_ROOT", "")
        if release_root_value:
            release_root = Path(release_root_value)
            environment = {**os.environ, "AGENT_BRIDGE_RELEASE_STAGE_TEST": "1"}
            subprocess.run([
                sys.executable, str(stage_helper), "--archive", str(archive),
                "--release-root", str(release_root), "--expected-commit", commit,
                "--archive-sha256", archive_sha256,
            ], check=True, env=environment)
            runner = os.environ.get("AGENT_BRIDGE_DEPLOY_TEST_RUNNER")
            if runner:
                runner_environment = os.environ.copy()
                runner_environment.update({
                    "AGENT_BRIDGE_DEPLOY_ARTIFACT_SHA256": archive_sha256,
                    "AGENT_BRIDGE_DEPLOY_ENVIRONMENT": approval_document["environment"],
                    "AGENT_BRIDGE_DEPLOY_APPROVAL_REFERENCE": approval_document["approval_reference"],
                })
                subprocess.run([runner, "--expected-commit", commit], check=True, env=runner_environment)
            return f"deployed {commit} {archive_sha256}"
        return f"validated {commit} {archive_sha256}"
    if os.geteuid() != 0:
        fail("agent-bridge-deploy must run as root")
    assert config is not None
    release_root = Path(configured_value(config, "release_root"))
    rollout_helper = Path("/usr/local/sbin/rollout-agent-bridge")
    subprocess.run([
        "/usr/bin/python3", str(stage_helper), "--archive", str(archive),
        "--release-root", str(release_root), "--expected-commit", commit,
        "--archive-sha256", archive_sha256,
    ], check=True)
    environment = os.environ.copy()
    environment["AGENT_BRIDGE_DEPLOYER_MODE"] = "1"
    environment["AGENT_BRIDGE_DEPLOY_ARTIFACT_SHA256"] = archive_sha256
    environment["AGENT_BRIDGE_DEPLOY_ENVIRONMENT"] = approval_document["environment"]
    environment["AGENT_BRIDGE_DEPLOY_APPROVAL_REFERENCE"] = approval_document["approval_reference"]
    subprocess.run([str(rollout_helper), "--expected-commit", commit], check=True, env=environment)
    return f"deployed {commit} {archive_sha256}"


def main() -> int:
    parser = argparse.ArgumentParser(prog="agent-bridge-deploy")
    parser.add_argument("--release", type=Path, required=True)
    parser.add_argument("--approval", type=Path)
    parser.add_argument("--owner-request", type=Path)
    parser.add_argument("--validate-only", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--internal-worker", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.approval is not None and args.owner_request is not None:
        parser.error("provide at most one of --approval or --owner-request")
    reject_root_test_overrides()
    if args.validate_only:
        os.environ["AGENT_BRIDGE_DEPLOY_VALIDATE_ONLY"] = "1"
    if os.geteuid() == 0 and not args.validate_only:
        unit = os.environ.get(DEPLOY_UNIT_ENV, "")
        if args.internal_worker:
            if not current_cgroup_has_unit(unit):
                fail("internal deployment worker is not running in its assigned transient systemd unit")
        else:
            return launch_detached(args.release, args.approval, args.owner_request)
    elif args.internal_worker:
        fail("internal deployment worker requires a root transient systemd unit")
    print(run_deployment(args.release, args.approval, args.owner_request))
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
