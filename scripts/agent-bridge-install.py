#!/usr/bin/env python3
"""One-time exact-release installer for a fresh Agent Bridge host."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import pwd
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Mapping, Sequence

SHA = re.compile(r"^[0-9a-f]{40}$")
TOKEN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$")
USERNAME = re.compile(r"^[a-z_][a-z0-9_-]*[$]?$")

DEFAULT_RELEASE_ROOT = Path("/opt/agent-bridge/releases")
DEFAULT_STATE_ROOT = Path("/var/lib/agent-bridge")
DEFAULT_BACKUP_DIR = Path("/var/backups/agent-bridge")
DEFAULT_LOG_DIR = Path("/var/log/agent-bridge/rollouts")
DEFAULTS_DIR = Path("/etc/default")
SYSTEMD_DIR = Path("/etc/systemd/system")
ROLLOUT_CONFIG = Path("/etc/agent-bridge/rollout.conf")
CLEANUP_SERVICE = "agent-bridge-tmp-cleanup.service"
CLEANUP_TIMER = "agent-bridge-tmp-cleanup.timer"
DEFAULT_AGENT_BRIDGE_SKILLS = (
    "red-green-refactor-tdd",
    "requirements-to-acceptance",
    "risk-based-test-strategy",
    "release-readiness-review",
    "delivery-directives",
    "git-sandbox",
    "cli-auth-telegram",
)

# unit, defaults file, enabling token(s), persistent database directory
SERVICES: tuple[tuple[str, str, tuple[str, ...], str], ...] = (
    ("agent-bridge-codex.service", "agent-bridge-codex", ("TELEGRAM_BOT_TOKEN_CODEX",), "codex"),
    ("agent-bridge-antigravity.service", "agent-bridge-antigravity", ("TELEGRAM_BOT_TOKEN_ANTIGRAVITY", "TELEGRAM_BOT_TOKEN_GEMINI"), "antigravity"),
    ("agent-bridge-claude.service", "agent-bridge-claude", ("TELEGRAM_BOT_TOKEN_CLAUDE",), "claude"),
    ("agent-bridge-interactive.service", "agent-bridge-interactive", ("TELEGRAM_BOT_TOKEN_INTERACTIVE",), "interactive"),
    ("agent-bridge-health.service", "agent-bridge-health", ("TELEGRAM_BOT_TOKEN_HEALTH",), "health"),
    ("agent-bridge-discord-interactive.service", "agent-bridge-discord-interactive", ("DISCORD_BOT_TOKEN",), "discord-interactive"),
)

# Provenance roles are intentionally independent of service database paths:
# the three single-CLI bridges share the same database shape but retain
# separate persistent state.
DATABASE_ROLES = {
    "codex": "shared",
    "antigravity": "shared",
    "claude": "shared",
    "interactive": "interactive",
    "health": "health",
    "discord-interactive": "discord",
}

# release path, installed path, rollout identity key
HELPERS: tuple[tuple[str, Path, str], ...] = (
    ("scripts/agent-bridge-deploy.py", Path("/usr/local/sbin/agent-bridge-deploy"), "deployer"),
    ("scripts/rollout-agent-bridge.sh", Path("/usr/local/sbin/rollout-agent-bridge"), "rollout"),
    ("scripts/release-stage.py", Path("/usr/local/libexec/agent-bridge-release-stage"), "stage"),
    ("scripts/release-activate.py", Path("/usr/local/libexec/agent-bridge-release-activate"), "activate"),
    ("scripts/rollout-restore.py", Path("/usr/local/libexec/agent-bridge-rollout-restore"), "restore"),
    ("scripts/rollout-authorization.py", Path("/usr/local/libexec/agent-bridge-rollout-authorization.py"), "authorization"),
    ("scripts/rollout-acceptance.py", Path("/usr/local/libexec/agent-bridge-rollout-acceptance.py"), "acceptance"),
)

SHARED_KEYS = (
    "TELEGRAM_ALLOWED_USER_IDS", "TELEGRAM_ALLOWED_USER_ID",
    "BRIDGE_EXECUTION_MODE", "BRIDGE_BUSY_MESSAGE_MODE", "BRIDGE_ASYNC_ENABLED",
    "POLL_INTERVAL_MS", "FETCH_TIMEOUT_MS", "AGENT_BRIDGE_INSTALLATION_ID",
    "AGENT_BRIDGE_SOUL_PATH", "AGENT_BRIDGE_SOUL_MODE",
    "BRIDGE_ADVISOR_ENABLED", "BRIDGE_ADVISOR_MODE", "BRIDGE_ADVISOR_CHAIN",
    "BRIDGE_ADVISOR_MAX_CALLS_PER_TURN", "BRIDGE_ADVISOR_MAX_CALLS_PER_TASK",
    "BRIDGE_ADVISOR_TIMEOUT_MS", "BRIDGE_ADVISOR_CONTEXT_MAX_CHARS",
    "HEALTH_MONITOR_ENABLED", "HEALTH_MONITOR_CADENCE_SECONDS",
    "HEALTH_MONITOR_AUTONOMY", "HEALTH_MONITOR_CHAT_ID", "HEALTH_SUGGEST_BOT",
    "HEALTH_BOT_MODE",
    "HEALTH_CONTENT_CRAWLER_ENABLED", "HEALTH_CONTENT_CRAWLER_SCRIPT",
)

SERVICE_KEYS = (
    "TELEGRAM_BOT_TOKEN_CODEX", "TELEGRAM_BOT_TOKEN_ANTIGRAVITY",
    "TELEGRAM_BOT_TOKEN_GEMINI", "TELEGRAM_BOT_TOKEN_CLAUDE",
    "TELEGRAM_BOT_TOKEN_INTERACTIVE",
    "TELEGRAM_BOT_TOKEN_HEALTH", "DISCORD_BOT_TOKEN", "DISCORD_APPLICATION_ID",
    "DISCORD_GUILD_ID", "DISCORD_ALLOWED_USER_IDS", "GITHUB_USERNAME",
    "GITHUB_TOKEN_FILE",
    "INTERACTIVE_DEFAULT_CLI", "INTERACTIVE_CLI_CHAIN", "BRIDGE_COMPACTION_CHAIN",
    "BRIDGE_COMPACTION_MAX_ATTEMPTS", "BRIDGE_COMPACTION_REPAIR_ATTEMPTS",
    "CODEX_COMMAND", "CODEX_MODEL_PREFERENCE", "CODEX_EFFORT", "CODEX_PROJECT_DIR",
    "ANTIGRAVITY_COMMAND", "ANTIGRAVITY_MODEL_PREFERENCE", "ANTIGRAVITY_EFFORT",
    "ANTIGRAVITY_PROJECT_DIR", "CLAUDE_COMMAND", "CLAUDE_MODEL_PREFERENCE",
    "CLAUDE_EFFORT", "CLAUDE_PROJECT_DIR", "KIMCHI_COMMAND",
    "KIMCHI_MODEL_PREFERENCE", "KIMCHI_PROJECT_DIR",
)


def fail(message: str) -> None:
    raise RuntimeError(message)


def digest(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        fail(f"unable to load helper: {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def selected_services(env: Mapping[str, str]) -> list[tuple[str, str, tuple[str, ...], str]]:
    health_mode = env.get("HEALTH_BOT_MODE", "standalone")
    if health_mode not in ("standalone", "integrated"):
        fail("HEALTH_BOT_MODE must be standalone or integrated")
    if health_mode == "integrated" and not env.get("TELEGRAM_BOT_TOKEN_INTERACTIVE", "").strip():
        fail("TELEGRAM_BOT_TOKEN_INTERACTIVE is required when HEALTH_BOT_MODE=integrated")
    selected = [service for service in SERVICES if any(env.get(key, "").strip() for key in service[2])]
    if health_mode == "integrated":
        health_service = next(service for service in SERVICES if service[3] == "health")
        if health_service not in selected:
            selected.append(health_service)
    if not selected:
        fail("at least one Agent Bridge service token must be configured")
    if env.get("DISCORD_BOT_TOKEN", "").strip() and not env.get("DISCORD_APPLICATION_ID", "").strip():
        fail("DISCORD_APPLICATION_ID is required with DISCORD_BOT_TOKEN")
    return selected


def database_path(state_root: Path, service: tuple[str, str, tuple[str, ...], str]) -> Path:
    return state_root / service[3] / "bridge.sqlite"


def require_fresh_database_targets(
    state_root: Path, services: Sequence[tuple[str, str, tuple[str, ...], str]],
) -> None:
    occupied = [str(path) for service in services if (path := database_path(state_root, service)).exists() or path.is_symlink()]
    if occupied:
        fail(f"persistent database targets already exist; refusing initial installation: {', '.join(occupied)}")


def bootstrap_databases(
    release: Path,
    node_bin: Path,
    account: pwd.struct_passwd,
    services: Sequence[tuple[str, str, tuple[str, ...], str]],
    databases: Sequence[Path],
) -> None:
    """Create schema-valid, provenance-bound databases before services start."""
    if len(services) != len(databases):
        fail("selected service and database inventories do not match")
    tsx = release / "node_modules/tsx/dist/cli.mjs"
    bootstrap = release / "scripts/rollout-db.ts"
    if any(path.is_symlink() or not path.is_file() for path in (tsx, bootstrap)):
        fail("release is missing database bootstrap runtime")
    for service, database in zip(services, databases):
        role = DATABASE_ROLES.get(service[3])
        if role is None:
            fail(f"unknown database role for service state: {service[3]}")
        subprocess.run([
            "/usr/sbin/runuser", "--user", account.pw_name, "--", str(node_bin),
            str(tsx), str(bootstrap), "bootstrap", "--db", str(database), "--role", role,
            "--confirm-new-role", str(database),
        ], check=True, capture_output=True, text=True)


def install_shared_skills(
    release: Path,
    node_bin: Path,
    account: pwd.struct_passwd,
    env: Mapping[str, str],
) -> None:
    """Install and verify bundled skills in the runtime user's shared home."""
    configured = env.get("AGENT_BRIDGE_SKILLS", ",".join(DEFAULT_AGENT_BRIDGE_SKILLS)).strip()
    if configured.lower() in {"none", "skip"}:
        return
    skills = [name.strip() for name in configured.split(",") if name.strip()]
    if not skills:
        fail("AGENT_BRIDGE_SKILLS must name at least one skill, none, or skip")
    link_mode = env.get("AGENT_BRIDGE_SKILL_LINK_MODE", "symlink")
    if link_mode not in {"symlink", "copy"}:
        fail("AGENT_BRIDGE_SKILL_LINK_MODE must be symlink or copy")

    tsx = release / "node_modules/tsx/dist/cli.mjs"
    manager = release / "scripts/skill-manager.ts"
    if any(path.is_symlink() or not path.is_file() for path in (tsx, manager)):
        fail("release is missing shared skill manager runtime")
    command_prefix = [
        "/usr/sbin/runuser", "--user", account.pw_name, "--", "env",
        f"HOME={account.pw_dir}", f"SHARED_MEMORY_HOME={account.pw_dir}",
        str(node_bin), str(tsx), str(manager),
    ]
    for skill in skills:
        subprocess.run([
            *command_prefix, "install", skill, "--force", "--link-mode", link_mode,
        ], check=True, capture_output=True, text=True)
    for skill in skills:
        subprocess.run([
            *command_prefix, "verify", skill,
        ], check=True, capture_output=True, text=True)


def remove_bootstrapped_databases(databases: Sequence[Path]) -> None:
    """Restore a retryable fresh-state boundary after bootstrap/start failure."""
    for database in databases:
        for path in (database, Path(f"{database}-wal"), Path(f"{database}-shm"), Path(f"{database}.provenance.json")):
            if path.is_symlink() or path.is_file():
                path.unlink()


def render_env(values: Mapping[str, str]) -> str:
    for key, value in values.items():
        if "\n" in value or "\r" in value:
            fail(f"environment value for {key} contains a newline")
    return "".join(f"{key}={values[key]}\n" for key in sorted(values))


def render_systemd_file(name: str, text: str, runtime_user: str) -> str:
    if "BRIDGE_USER" in text:
        return text.replace("BRIDGE_USER", runtime_user)
    if name.endswith(".timer"):
        return text
    fail(f"systemd unit has no BRIDGE_USER placeholder: {name}")


def render_rollout_config(
    release_root: Path,
    environment: str,
    runtime_user: str,
    node_bin: Path,
    units: Sequence[str],
    databases: Sequence[Path],
    helpers: Mapping[str, Path],
    backup_dir: Path = DEFAULT_BACKUP_DIR,
    log_dir: Path = DEFAULT_LOG_DIR,
) -> str:
    lines = [
        f"release_root={release_root}",
        f"current_pointer={release_root / 'current'}",
        f"rollout_helper_sha256={digest(helpers['rollout'])}",
        f"activation_helper_sha256={digest(helpers['activate'])}",
        f"authorization_validator_sha256={digest(helpers['authorization'])}",
        f"acceptance_validator_sha256={digest(helpers['acceptance'])}",
        f"release_stage_sha256={digest(helpers['stage'])}",
        f"rollout_restore_sha256={digest(helpers['restore'])}",
        f"environment={environment}",
        f"runtime_user={runtime_user}",
        f"node_bin={node_bin}",
        f"backup_dir={backup_dir}",
        f"log_dir={log_dir}",
    ]
    lines += [f"unit={unit}" for unit in units]
    lines += [f"database={database}" for database in databases]
    return "\n".join(lines) + "\n"


def safe_write(path: Path, content: str, mode: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        os.chown(temporary, 0, 0)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def install_file(source: Path, destination: Path, mode: int) -> None:
    if source.is_symlink() or not source.is_file():
        fail(f"release is missing required regular file: {source}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(f".{destination.name}.tmp-{os.getpid()}")
    try:
        shutil.copyfile(source, temporary, follow_symlinks=False)
        os.chmod(temporary, mode)
        os.chown(temporary, 0, 0)
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def validate_host(runtime_user: str, node_bin: Path) -> pwd.struct_passwd:
    if not USERNAME.fullmatch(runtime_user) or runtime_user == "root":
        fail("runtime user must be an existing non-root account")
    try:
        account = pwd.getpwnam(runtime_user)
    except KeyError:
        fail(f"runtime user does not exist: {runtime_user}")
    if not node_bin.is_absolute() or node_bin.is_symlink() or not node_bin.is_file() or not os.access(node_bin, os.X_OK):
        fail("node binary must be an absolute executable regular non-symlink file")
    try:
        major = int(subprocess.run(
            [str(node_bin), "-p", "process.versions.node.split('.')[0]"],
            check=True, capture_output=True, text=True,
        ).stdout.strip())
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        fail(f"unable to validate Node.js: {error}")
    if major < 24:
        fail(f"Node.js 24+ is required; found major {major}")
    sudo_check = subprocess.run(
        ["/usr/sbin/runuser", "--user", runtime_user, "--", "/usr/bin/sudo", "-k", "-n", "true"],
        check=False, capture_output=True, text=True, timeout=5,
    )
    if sudo_check.returncode != 0:
        fail(f"passwordless sudo verification failed for {runtime_user}")
    return account


def inspect_archive(archive: Path, stage_module, destination: Path) -> tuple[dict, str]:
    if archive.is_symlink() or not archive.is_file():
        fail("release archive must be a regular non-symlink file")
    archive_sha256 = digest(archive)
    with archive.open("rb") as stream:
        stage_module.extract_archive(stream, destination)
    manifest = stage_module.load_manifest(destination)
    stage_module.verify_manifest(destination, manifest)
    evidence_path = destination / "qualification-evidence.json"
    if evidence_path.is_symlink() or not evidence_path.is_file():
        fail("release archive must contain qualification-evidence.json")
    try:
        evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        fail(f"invalid qualification evidence: {error}")
    if evidence.get("commit") != manifest.get("commit") or evidence.get("tree") != manifest.get("tree"):
        fail("qualification evidence does not match the release manifest")
    return manifest, archive_sha256


def service_values(
    env: Mapping[str, str], defaults_path: Path, db_path: Path, token_keys: Sequence[str], health_db_path: Path | None = None,
) -> dict[str, str]:
    values = {"BRIDGE_ENV_FILE": str(defaults_path), "DB_PATH": str(db_path)}
    other_tokens = {key for service in SERVICES for key in service[2] if key not in token_keys}
    for key in set(SERVICE_KEYS) - other_tokens:
        if env.get(key, "") != "":
            values[key] = env[key]
    if defaults_path.name == "agent-bridge-health" and env.get("HEALTH_BOT_MODE", "standalone") == "integrated":
        values["TELEGRAM_BOT_TOKEN_INTERACTIVE"] = env["TELEGRAM_BOT_TOKEN_INTERACTIVE"]
    if env.get("HEALTH_BOT_MODE", "standalone") == "integrated" and defaults_path.name in {"agent-bridge-health", "agent-bridge-interactive"}:
        if health_db_path is None:
            fail("integrated health defaults require the generated health database path")
        values["HEALTH_DB_PATH"] = str(health_db_path)
    return values


def configure_host(
    release: Path,
    account: pwd.struct_passwd,
    node_bin: Path,
    selected: Sequence[tuple[str, str, tuple[str, ...], str]],
    env: Mapping[str, str],
    release_root: Path,
    state_root: Path,
    backup_dir: Path,
    log_dir: Path,
    environment: str,
) -> tuple[list[str], list[Path]]:
    current = release_root / "current"
    shared = {
        "BRIDGE_ROOT_DIR": account.pw_dir,
        "BRIDGE_PROJECT_DIR": str(current),
        "NODE_BIN": str(node_bin),
        "BRIDGE_EXECUTION_MODE": env.get("BRIDGE_EXECUTION_MODE", "trusted"),
        "BRIDGE_BUSY_MESSAGE_MODE": env.get("BRIDGE_BUSY_MESSAGE_MODE", "augment"),
        "BRIDGE_ASYNC_ENABLED": env.get("BRIDGE_ASYNC_ENABLED", "true"),
        "POLL_INTERVAL_MS": env.get("POLL_INTERVAL_MS", "1000"),
        "FETCH_TIMEOUT_MS": env.get("FETCH_TIMEOUT_MS", "45000"),
    }
    shared.update({key: env[key] for key in SHARED_KEYS if env.get(key, "") != ""})
    if not (shared.get("TELEGRAM_ALLOWED_USER_IDS") or shared.get("TELEGRAM_ALLOWED_USER_ID") or env.get("DISCORD_ALLOWED_USER_IDS")):
        fail("an allowed Telegram or Discord user ID must be configured")
    safe_write(DEFAULTS_DIR / "agent-bridge-shared", render_env(shared), 0o600)
    safe_write(DEFAULTS_DIR / "agent-bridge-release", render_env({"BRIDGE_CURRENT_RELEASE_DIR": str(current)}), 0o600)

    state_root.mkdir(parents=True, exist_ok=True)
    units: list[str] = []
    databases: list[Path] = []
    health_db_path = next((database_path(state_root, service) for service in selected if service[3] == "health"), None)
    for unit, defaults_name, token_keys, db_name in selected:
        service = (unit, defaults_name, token_keys, db_name)
        db_path = database_path(state_root, service)
        db_path.parent.mkdir(parents=True, exist_ok=True)
        os.chown(db_path.parent, account.pw_uid, account.pw_gid)
        os.chmod(db_path.parent, 0o750)
        defaults_path = DEFAULTS_DIR / defaults_name
        safe_write(defaults_path, render_env(service_values(env, defaults_path, db_path, token_keys, health_db_path)), 0o600)
        unit_source = release / "systemd" / unit
        if unit_source.is_symlink() or not unit_source.is_file():
            fail(f"release is missing systemd unit: {unit_source}")
        safe_write(SYSTEMD_DIR / unit, render_systemd_file(unit, unit_source.read_text(encoding="utf-8"), account.pw_name), 0o644)
        units.append(unit)
        databases.append(db_path)

    for name in (CLEANUP_SERVICE, CLEANUP_TIMER):
        source = release / "systemd" / name
        if source.is_symlink() or not source.is_file():
            fail(f"release is missing systemd unit: {source}")
        safe_write(SYSTEMD_DIR / name, render_systemd_file(name, source.read_text(encoding="utf-8"), account.pw_name), 0o644)

    installed: dict[str, Path] = {}
    for source_name, destination, identity in HELPERS:
        install_file(release / source_name, destination, 0o750)
        installed[identity] = destination

    for directory in (backup_dir, log_dir):
        directory.mkdir(parents=True, exist_ok=True)
        os.chmod(directory, 0o700)
    safe_write(ROLLOUT_CONFIG, render_rollout_config(
        release_root, environment, account.pw_name, node_bin, units, databases,
        installed, backup_dir, log_dir,
    ), 0o600)
    return units, databases


def systemctl(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["/usr/bin/systemctl", *args], check=check, capture_output=True, text=True)


def accept(units: Sequence[str], databases: Sequence[Path], timeout: int) -> None:
    deadline = time.monotonic() + timeout
    pending = set(units)
    while pending and time.monotonic() < deadline:
        pending = {
            unit for unit in pending
            if systemctl("is-active", "--quiet", unit, check=False).returncode != 0
        }
        if pending:
            time.sleep(1)
    if pending:
        fail(f"services did not become active: {', '.join(sorted(pending))}")
    for database in databases:
        while not database.is_file() and time.monotonic() < deadline:
            time.sleep(0.25)
        if database.is_symlink() or not database.is_file():
            fail(f"service database was not created: {database}")
        connection = sqlite3.connect(f"file:{database}?mode=ro", uri=True)
        try:
            if connection.execute("PRAGMA quick_check").fetchone() != ("ok",):
                fail(f"database quick_check failed: {database}")
            if connection.execute("PRAGMA foreign_key_check").fetchone() is not None:
                fail(f"database foreign_key_check failed: {database}")
        finally:
            connection.close()


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="agent-bridge-install")
    parser.add_argument("--release", required=True, type=Path)
    parser.add_argument("--runtime-user", required=True)
    parser.add_argument("--node-bin", required=True, type=Path)
    parser.add_argument("--environment", default="production-agent-bridge")
    parser.add_argument("--release-root", type=Path, default=DEFAULT_RELEASE_ROOT)
    parser.add_argument("--state-root", type=Path, default=DEFAULT_STATE_ROOT)
    parser.add_argument("--backup-dir", type=Path, default=DEFAULT_BACKUP_DIR)
    parser.add_argument("--log-dir", type=Path, default=DEFAULT_LOG_DIR)
    parser.add_argument("--acceptance-timeout", type=int, default=30)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    if os.geteuid() != 0:
        fail("agent-bridge-install must run as root")
    test_keys = sorted(key for key in os.environ if key.startswith("AGENT_BRIDGE_") and "_TEST" in key)
    if test_keys:
        fail(f"test overrides are forbidden during root installation: {', '.join(test_keys)}")
    if not TOKEN.fullmatch(args.environment) or args.acceptance_timeout <= 0:
        fail("invalid environment identity or acceptance timeout")

    node_bin = args.node_bin.absolute()
    account = validate_host(args.runtime_user, node_bin)
    selected = selected_services(os.environ)
    release_root = args.release_root.absolute()
    state_root = args.state_root.absolute()
    backup_dir = args.backup_dir.absolute()
    log_dir = args.log_dir.absolute()
    for path, label in ((state_root, "state"), (backup_dir, "backup"), (log_dir, "log")):
        if path == release_root or release_root in path.parents:
            fail(f"{label} directory must be outside the immutable release root")
    current = release_root / "current"
    if current.exists() or current.is_symlink():
        fail("an active release already exists; use agent-bridge-deploy for upgrades")
    require_fresh_database_targets(state_root, selected)

    bootstrap_stage = load_module("agent_bridge_bootstrap_stage", Path(__file__).with_name("release-stage.py"))
    managed_units: list[str] = []
    bootstrapped_databases: list[Path] = []
    activated_commit = ""
    archive_sha256 = ""
    try:
        with tempfile.TemporaryDirectory(prefix="agent-bridge-install-") as directory:
            extracted = Path(directory)
            manifest, archive_sha256 = inspect_archive(args.release, bootstrap_stage, extracted)
            activated_commit = manifest["commit"]
            if not SHA.fullmatch(activated_commit):
                fail("release manifest commit is invalid")
            units, databases = configure_host(
                extracted, account, node_bin, selected, os.environ, release_root,
                state_root, backup_dir, log_dir, args.environment,
            )
            managed_units = [*units, CLEANUP_TIMER]
            systemctl("daemon-reload")
            systemctl("enable", *managed_units)

            stage = load_module("agent_bridge_release_stage", extracted / "scripts/release-stage.py")
            print(stage.stage(args.release, release_root, activated_commit, archive_sha256), flush=True)
            activate = load_module("agent_bridge_release_activate", extracted / "scripts/release-activate.py")
            activate.validate_release(release_root / activated_commit, activated_commit, strict=True)
            install_shared_skills(release_root / activated_commit, node_bin, account, os.environ)
            bootstrapped_databases = list(databases)
            bootstrap_databases(release_root / activated_commit, node_bin, account, selected, databases)
            print(activate.activate(release_root, current, activated_commit), flush=True)

            systemctl("start", *managed_units)
            accept(units, databases, args.acceptance_timeout)
            result = {
                "schema_version": 1,
                "status": "installed",
                "commit": activated_commit,
                "archive_sha256": archive_sha256,
                "runtime_user": args.runtime_user,
                "environment": args.environment,
                "units": units,
                "databases": [str(path) for path in databases],
            }
            safe_write(state_root / "installation-result.json", json.dumps(result, sort_keys=True, indent=2) + "\n", 0o600)
            print(f"installed {activated_commit} {archive_sha256}")
            return 0
    except Exception as error:
        if managed_units:
            systemctl("disable", "--now", *reversed(managed_units), check=False)
        remove_bootstrapped_databases(bootstrapped_databases)
        if current.is_symlink() and os.readlink(current) == activated_commit:
            current.unlink()
        if activated_commit:
            try:
                safe_write(state_root / "installation-result.json", json.dumps({
                    "schema_version": 1,
                    "status": "failed",
                    "commit": activated_commit,
                    "archive_sha256": archive_sha256,
                    "error": str(error),
                }, sort_keys=True, indent=2) + "\n", 0o600)
            except Exception:
                pass
        raise


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"agent-bridge-install: {error}", file=sys.stderr)
        raise SystemExit(1)
