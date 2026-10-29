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
import stat
import sqlite3
import subprocess
import sys
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
    "release-readiness-review",
    "systematic-debugging",
    "delivery-directives",
    "git-sandbox",
    "cli-auth-telegram",
    "autonomous-work",
    "scheduled-routines",
    "sensors",
    "engineering-retro",
)

# unit, defaults file, enabling token(s), persistent database directory
SERVICES: tuple[tuple[str, str, tuple[str, ...], str], ...] = (
    ("agent-bridge-codex.service", "agent-bridge-codex", ("TELEGRAM_BOT_TOKEN_CODEX",), "codex"),
    ("agent-bridge-antigravity.service", "agent-bridge-antigravity", ("TELEGRAM_BOT_TOKEN_ANTIGRAVITY", "TELEGRAM_BOT_TOKEN_GEMINI"), "antigravity"),
    ("agent-bridge-claude.service", "agent-bridge-claude", ("TELEGRAM_BOT_TOKEN_CLAUDE",), "claude"),
    ("agent-bridge-interactive.service", "agent-bridge-interactive", ("TELEGRAM_BOT_TOKEN_INTERACTIVE",), "interactive"),
    ("agent-bridge-discord-interactive.service", "agent-bridge-discord-interactive", ("DISCORD_BOT_TOKEN",), "discord-interactive"),
    ("agent-bridge-slack-interactive.service", "agent-bridge-slack-interactive", ("SLACK_BOT_TOKEN_FILE",), "slack-interactive"),
)

# Provenance roles are intentionally independent of service database paths:
# the three single-CLI bridges share the same database shape but retain
# separate persistent state.
DATABASE_ROLES = {
    "codex": "shared",
    "antigravity": "shared",
    "claude": "shared",
    "interactive": "interactive",
    "discord-interactive": "discord",
    "slack-interactive": "slack",
}

# release path, installed path, rollout identity key
HELPERS: tuple[tuple[str, Path, str], ...] = (
    ("scripts/agent-bridge-deploy.py", Path("/usr/local/sbin/agent-bridge-deploy"), "deployer"),
    ("scripts/rollout-agent-bridge.sh", Path("/usr/local/sbin/rollout-agent-bridge"), "rollout"),
    ("scripts/rollout-sentinel-clear.sh", Path("/usr/local/sbin/rollout-sentinel-clear"), "sentinel_clear"),
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
    "AGENT_BRIDGE_AUTONOMY_DIR", "AGENT_BRIDGE_AUTONOMY_DB_PATH",
    "AGENT_BRIDGE_AUTONOMY_MAX_CYCLES",
    "AGENT_BRIDGE_AUTONOMY_REQUIRE_EPISODE_APPROVAL",
    "AGENT_BRIDGE_AUTONOMY_MAX_EPISODES_PER_DAY",
    "AGENT_BRIDGE_SENSOR_CONFIG",
    "AGENT_BRIDGE_MAX_CONCURRENT_EXECUTIONS",
    "CODEX_ACP_COMMAND", "CODEX_ACP_ARGS", "CLAUDE_ACP_COMMAND", "CLAUDE_ACP_ARGS",
    "GROK_ACP_COMMAND", "GROK_ACP_ARGS",
    "AGY_ACP_COMMAND", "AGY_ACP_ARGS",
    "CURSOR_ACP_COMMAND", "CURSOR_ACP_ARGS",
)

SERVICE_KEYS = (
    "TELEGRAM_BOT_TOKEN_CODEX", "TELEGRAM_BOT_TOKEN_ANTIGRAVITY",
    "TELEGRAM_BOT_TOKEN_GEMINI", "TELEGRAM_BOT_TOKEN_CLAUDE",
    "TELEGRAM_BOT_TOKEN_INTERACTIVE",
    "DISCORD_BOT_TOKEN", "DISCORD_APPLICATION_ID",
    "DISCORD_GUILD_ID", "DISCORD_ALLOWED_USER_IDS",
    "SLACK_BOT_TOKEN_FILE", "SLACK_APP_TOKEN_FILE", "SLACK_ALLOWED_USER_IDS", "SLACK_STATUS_FILE",
    "GITHUB_USERNAME",
    "GITHUB_TOKEN_FILE",
    "INTERACTIVE_DEFAULT_CLI", "INTERACTIVE_CLI_CHAIN", "BRIDGE_COMPACTION_CHAIN",
    "BRIDGE_COMPACTION_MAX_ATTEMPTS", "BRIDGE_COMPACTION_REPAIR_ATTEMPTS",
    "CODEX_MODEL_PREFERENCE", "CODEX_EFFORT", "CODEX_PROJECT_DIR",
    "CODEX_ACP_COMMAND", "CODEX_ACP_ARGS", "CLAUDE_ACP_COMMAND", "CLAUDE_ACP_ARGS",
    "AGY_ACP_COMMAND", "AGY_ACP_ARGS",
    "ANTIGRAVITY_MODEL_PREFERENCE", "ANTIGRAVITY_EFFORT",
    "ANTIGRAVITY_PROJECT_DIR", "CLAUDE_ACP_COMMAND", "CLAUDE_ACP_ARGS", "CLAUDE_MODEL_PREFERENCE",
    "CLAUDE_EFFORT", "CLAUDE_PROJECT_DIR", "GROK_ACP_COMMAND", "GROK_ACP_ARGS",
    "GROK_MODEL_PREFERENCE", "GROK_EFFORT", "GROK_PROJECT_DIR",
    "CURSOR_ACP_COMMAND", "CURSOR_ACP_ARGS", "CURSOR_MODEL_PREFERENCE", "CURSOR_EFFORT", "CURSOR_PROJECT_DIR",
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
    if env.get("SLACK_BOT_TOKEN", "").strip() or env.get("SLACK_APP_TOKEN", "").strip():
        fail("Production Slack credentials must be supplied as private token files, not env tokens")
    slack_fields = ("SLACK_BOT_TOKEN_FILE", "SLACK_APP_TOKEN_FILE", "SLACK_ALLOWED_USER_IDS")
    if any(env.get(k, "").strip() for k in slack_fields) and not all(env.get(k, "").strip() for k in slack_fields):
        fail("Slack requires both token FILE paths and a nonempty user ID allowlist")
    selected = [service for service in SERVICES if any(env.get(key, "").strip() for key in service[2])]
    if not selected:
        fail("at least one Agent Bridge service token must be configured")
    if env.get("DISCORD_BOT_TOKEN", "").strip() and not env.get("DISCORD_APPLICATION_ID", "").strip():
        fail("DISCORD_APPLICATION_ID is required with DISCORD_BOT_TOKEN")
    return selected


def validate_slack_credentials(env: Mapping[str, str], account: pwd.struct_passwd, release_root: Path) -> None:
    """Preflight two external, runtime-readable private token files before changing host state."""
    if not env.get("SLACK_BOT_TOKEN_FILE", "").strip():
        return
    for key, prefix in (("SLACK_BOT_TOKEN_FILE", "xoxb-"), ("SLACK_APP_TOKEN_FILE", "xapp-")):
        raw = env[key]
        path = Path(raw)
        if not path.is_absolute() or os.path.normpath(raw) != raw or release_root in path.parents:
            fail(f"{key} must be a canonical absolute path outside the immutable release root")
        try:
            info = path.lstat()
        except OSError:
            fail(f"{key} is missing or unreadable")
        if not stat.S_ISREG(info.st_mode) or info.st_uid != account.pw_uid or info.st_mode & 0o077:
            fail(f"{key} must be an owner-only regular file owned by the runtime user")
        # Read prefix only, avoid exposing contents through argv, logs or permanent defaults.
        if not path.read_text(encoding="utf-8").strip().startswith(prefix):
            fail(f"{key} must contain the correct nonrotating Slack token type")
    user_ids = [v.strip() for v in env["SLACK_ALLOWED_USER_IDS"].split(",") if v.strip()]
    if not user_ids or any(re.fullmatch(r"[UW][A-Z0-9]{2,}", v) is None for v in user_ids):
        fail("SLACK_ALLOWED_USER_IDS must contain Slack member IDs (default deny)")



def database_path(state_root: Path, service: tuple[str, str, tuple[str, ...], str]) -> Path:
    return state_root / service[3] / "bridge.sqlite"


def configured_autonomy_database(
    env: Mapping[str, str],
    state_root: Path,
    services: Sequence[tuple[str, str, tuple[str, ...], str]],
) -> Path | None:
    raw = env.get("AGENT_BRIDGE_AUTONOMY_DB_PATH", "")
    if not raw:
        return None
    if (
        not Path(raw).is_absolute()
        or any(char.isspace() for char in raw)
        or any(char in "\"'\\$" for char in raw)
        or os.path.normpath(raw) != raw
    ):
        fail("AGENT_BRIDGE_AUTONOMY_DB_PATH must be a canonical absolute path without shell metacharacters")
    if not any(service[0] == "agent-bridge-interactive.service" for service in services):
        fail("AGENT_BRIDGE_AUTONOMY_DB_PATH requires agent-bridge-interactive.service")
    path = Path(raw)
    if path.parent.parent != state_root:
        fail("AGENT_BRIDGE_AUTONOMY_DB_PATH must live in a direct child of the managed state root")
    primary_paths = {database_path(state_root, service) for service in services}
    if path in primary_paths:
        fail("AGENT_BRIDGE_AUTONOMY_DB_PATH must not duplicate a primary service database")
    return path


def require_fresh_database_targets(
    state_root: Path,
    services: Sequence[tuple[str, str, tuple[str, ...], str]],
    env: Mapping[str, str] | None = None,
) -> None:
    env = os.environ if env is None else env
    targets = [database_path(state_root, service) for service in services]
    autonomy_database = configured_autonomy_database(env, state_root, services)
    if autonomy_database is not None:
        targets.append(autonomy_database)
    occupied = [str(path) for path in targets if path.exists() or path.is_symlink()]
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
    if len(databases) not in {len(services), len(services) + 1}:
        fail("selected service and database inventories do not match")
    tsx = release / "node_modules/tsx/dist/cli.mjs"
    bootstrap = release / "scripts/rollout-db.ts"
    if any(path.is_symlink() or not path.is_file() for path in (tsx, bootstrap)):
        fail("release is missing database bootstrap runtime")

    def bootstrap_database(database: Path, role: str) -> None:
        subprocess.run([
            "/usr/sbin/runuser", "--user", account.pw_name, "--", str(node_bin),
            str(tsx), str(bootstrap), "bootstrap", "--db", str(database), "--role", role,
            "--confirm-new-role", str(database),
        ], check=True, capture_output=True, text=True)

    for service, database in zip(services, databases[:len(services)]):
        role = DATABASE_ROLES.get(service[3])
        if role is None:
            fail(f"unknown database role for service state: {service[3]}")
        bootstrap_database(database, role)
    if len(databases) == len(services) + 1:
        if not any(service[0] == "agent-bridge-interactive.service" for service in services):
            fail("secondary autonomy database requires agent-bridge-interactive.service")
        bootstrap_database(databases[-1], "interactive")


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
    # Legacy installations may still explicitly include this retired bundled skill.
    skills = [name for name in skills if name != "advisor"]
    if "autonomous-work" not in skills:
        skills.append("autonomous-work")
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
    # Retired bundled skill: the ownership-aware uninstall refuses user-owned or
    # unregistered entries, which are intentionally left untouched.
    subprocess.run([*command_prefix, "uninstall", "advisor"], check=False, capture_output=True, text=True)


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


def ensure_config_directory(path: Path, account: pwd.struct_passwd) -> None:
    path.mkdir(parents=True, exist_ok=True)
    if path.is_symlink() or not path.is_dir():
        fail(f"configuration directory must be a canonical directory: {path}")
    os.chown(path, 0, account.pw_gid)
    os.chmod(path, 0o750)


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


# Security floors per supported Node.js line (October 2026 security releases).
NODE_SECURITY_FLOORS = {24: (24, 22, 1), 26: (26, 12, 1)}


def node_version_admitted(version: str) -> bool:
    match = re.fullmatch(r"v?(\d+)\.(\d+)\.(\d+)", version)
    if not match:
        return False
    parsed = tuple(int(part) for part in match.groups())
    floor = NODE_SECURITY_FLOORS.get(parsed[0])
    return floor is not None and parsed >= floor


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
        version = subprocess.run(
            [str(node_bin), "-p", "process.versions.node"],
            check=True, capture_output=True, text=True,
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError) as error:
        fail(f"unable to validate Node.js: {error}")
    if not node_version_admitted(version):
        floors = " ".join(".".join(map(str, floor)) for floor in NODE_SECURITY_FLOORS.values())
        fail(f"Node.js {version} is unsupported or has known vulnerabilities; required minimum per line: {floors}")
    sudo_check = subprocess.run(
        ["/usr/sbin/runuser", "--user", runtime_user, "--", "/usr/bin/sudo", "-k", "-n", "true"],
        check=False, capture_output=True, text=True, timeout=5,
    )
    if sudo_check.returncode != 0:
        fail(f"passwordless sudo verification failed for {runtime_user}")
    return account


def release_was_created_by_stage(stage_message: str) -> bool:
    return stage_message.startswith("staged ")


def discard_staged_release(release_root: Path, commit: str) -> None:
    if not SHA.fullmatch(commit):
        fail("refusing to discard a release with an invalid commit")
    release = release_root / commit
    if release.is_symlink():
        fail("refusing to discard a symlinked release path")
    if release.exists():
        if not release.is_dir():
            fail("refusing to discard a release path that is not a directory")
        for current, _directories, files in os.walk(release, topdown=True, followlinks=False):
            current_path = Path(current)
            if current_path.is_symlink():
                continue
            os.chmod(current_path, 0o755)
            for name in files:
                path = current_path / name
                if not path.is_symlink():
                    os.chmod(path, 0o644)
        shutil.rmtree(release)
    provenance = release_root / f".{commit}.staging-provenance.json"
    if provenance.is_symlink():
        fail("refusing to discard symlinked staging provenance")
    if provenance.exists():
        os.chmod(provenance, 0o644)
        provenance.unlink()


def prepare_install_release(archive: Path, release_root: Path, stage_module) -> tuple[dict, str, Path, str]:
    """Inspect an archive once, then stage one immutable candidate."""
    if archive.is_symlink() or not archive.is_file():
        fail("release archive must be a regular non-symlink file")
    inspected = stage_module.inspect_archive(archive)
    manifest = inspected["manifest"]
    archive_sha256 = inspected["archive_sha256"]
    qualification_text = inspected.get("qualification_text")
    if not isinstance(qualification_text, str):
        fail("release archive must contain qualification-evidence.json")
    try:
        evidence = json.loads(qualification_text)
    except json.JSONDecodeError as error:
        fail(f"invalid qualification evidence: {error}")
    if evidence.get("commit") != manifest.get("commit") or evidence.get("tree") != manifest.get("tree"):
        fail("qualification evidence does not match the release manifest")
    commit = manifest["commit"]
    if not isinstance(commit, str) or not SHA.fullmatch(commit):
        fail("release manifest commit is invalid")
    if not isinstance(archive_sha256, str):
        fail("release archive SHA-256 is invalid")
    message = stage_module.stage(archive, release_root, commit, archive_sha256)
    return manifest, archive_sha256, release_root / commit, message


def service_values(
    env: Mapping[str, str], defaults_path: Path, db_path: Path, token_keys: Sequence[str],
) -> dict[str, str]:
    values = {"BRIDGE_ENV_FILE": str(defaults_path), "DB_PATH": str(db_path)}
    other_tokens = {key for service in SERVICES for key in service[2] if key not in token_keys}
    for key in set(SERVICE_KEYS) - other_tokens:
        if env.get(key, "") != "":
            values[key] = env[key]
    slack_keys = ("SLACK_BOT_TOKEN_FILE", "SLACK_APP_TOKEN_FILE", "SLACK_ALLOWED_USER_IDS", "SLACK_STATUS_FILE")
    if defaults_path.name == "agent-bridge-slack-interactive":
        # Slack is operator-opted-in with two external files; never persist raw tokens.
        values["BRIDGE_EXECUTION_MODE"] = "safe"
        values.pop("SLACK_BOT_TOKEN", None)
        values.pop("SLACK_APP_TOKEN", None)
    else:
        for key in slack_keys:
            values.pop(key, None)
    if defaults_path.name == "agent-bridge-interactive":
        for key in ("BRIDGE_RUN_INGRESS_SOCKET", "BRIDGE_RUN_INGRESS_TOKEN"):
            if env.get(key, "") != "":
                values[key] = env[key]
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
    ensure_config_directory(ROLLOUT_CONFIG.parent, account)
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
    raw_capacity = env.get("AGENT_BRIDGE_MAX_CONCURRENT_EXECUTIONS", "0")
    if not re.fullmatch(r"0|[1-9][0-9]*", raw_capacity):
        fail("AGENT_BRIDGE_MAX_CONCURRENT_EXECUTIONS must be a non-negative integer")
    if int(raw_capacity) > 0:
        # Every selected surface inherits this one already-managed SQLite DB.
        # Prefer the ordinary interactive DB when present; otherwise use the
        # first selected service DB. The installer bootstraps it below, so it
        # never creates an extra coordinator database.
        coordinator_service = next((service for service in selected if service[3] == "interactive"), selected[0])
        shared["AGENT_BRIDGE_EXECUTION_COORDINATION_DB_PATH"] = str(database_path(state_root, coordinator_service))
    if not (shared.get("TELEGRAM_ALLOWED_USER_IDS") or shared.get("TELEGRAM_ALLOWED_USER_ID") or env.get("DISCORD_ALLOWED_USER_IDS") or env.get("SLACK_ALLOWED_USER_IDS")):
        fail("an allowed Telegram, Discord or Slack user ID must be configured")
    safe_write(DEFAULTS_DIR / "agent-bridge-shared", render_env(shared), 0o600)
    safe_write(DEFAULTS_DIR / "agent-bridge-release", render_env({"BRIDGE_CURRENT_RELEASE_DIR": str(current)}), 0o600)

    state_root.mkdir(parents=True, exist_ok=True)
    units: list[str] = []
    databases: list[Path] = []
    for unit, defaults_name, token_keys, db_name in selected:
        service = (unit, defaults_name, token_keys, db_name)
        db_path = database_path(state_root, service)
        db_path.parent.mkdir(parents=True, exist_ok=True)
        os.chown(db_path.parent, account.pw_uid, account.pw_gid)
        os.chmod(db_path.parent, 0o750)
        defaults_path = DEFAULTS_DIR / defaults_name
        settings = service_values(env, defaults_path, db_path, token_keys)
        if db_name == "slack-interactive":
            settings["SLACK_STATUS_FILE"] = str(db_path.parent / "slack-status.json")
        safe_write(defaults_path, render_env(settings), 0o600)
        unit_source = release / "systemd" / unit
        if unit_source.is_symlink() or not unit_source.is_file():
            fail(f"release is missing systemd unit: {unit_source}")
        safe_write(SYSTEMD_DIR / unit, render_systemd_file(unit, unit_source.read_text(encoding="utf-8"), account.pw_name), 0o644)
        units.append(unit)
        databases.append(db_path)

    autonomy_database = configured_autonomy_database(env, state_root, selected)
    if autonomy_database is not None:
        if state_root.is_symlink() or not state_root.is_dir() or state_root.resolve() != state_root:
            fail("managed state root must be a canonical non-symlink directory for autonomy database provisioning")
        autonomy_parent = autonomy_database.parent
        autonomy_parent.mkdir(mode=0o750, exist_ok=True)
        if autonomy_parent.is_symlink() or not autonomy_parent.is_dir() or autonomy_parent.resolve() != autonomy_parent:
            fail("autonomy database parent must be a canonical non-symlink directory")
        os.chown(autonomy_parent, account.pw_uid, account.pw_gid)
        os.chmod(autonomy_parent, 0o750)
        databases.append(autonomy_database)

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


def accept(units: Sequence[str], databases: Sequence[Path], timeout: int, state_root: Path | None = None) -> None:
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
    if "agent-bridge-slack-interactive.service" in units and state_root is not None:
        status_path = state_root / "slack-interactive" / "slack-status.json"
        ready = False
        while time.monotonic() < deadline:
            try:
                status_info = status_path.lstat()
                if not stat.S_ISREG(status_info.st_mode) or status_info.st_mode & 0o077:
                    fail("Slack readiness file has unsafe permissions")
                status = json.loads(status_path.read_text(encoding="utf-8"))
                pid = status.get("pid")
                age = time.time() - (status_path.stat().st_mtime)
                if (
                    status.get("schemaVersion") == 1
                    and status.get("state") == "connected"
                    and status.get("errorCode") is None
                    and status.get("appId") and status.get("teamId")
                    and isinstance(pid, int) and pid > 1 and age < 45
                    and status.get("generation")
                ):
                    os.kill(pid, 0)
                    active_pid = systemctl(
                        "show", "--property=MainPID", "--value",
                        "agent-bridge-slack-interactive.service",
                    ).stdout.strip()
                    if active_pid != str(pid):
                        raise ValueError("stale Slack status process")
                    ready = True
                    break
            except (OSError, ValueError, json.JSONDecodeError, TypeError):
                pass
            time.sleep(1)
        if not ready:
            fail("Slack Socket Mode did not prove a live connected app/team before acceptance deadline")
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
    validate_slack_credentials(os.environ, account, release_root)
    require_fresh_database_targets(state_root, selected, os.environ)

    bootstrap_stage = load_module("agent_bridge_bootstrap_stage", Path(__file__).with_name("release-stage.py"))
    managed_units: list[str] = []
    bootstrapped_databases: list[Path] = []
    activated_commit = ""
    archive_sha256 = ""
    stage_message = ""
    try:
        manifest, archive_sha256, staged_dir, stage_message = prepare_install_release(args.release, release_root, bootstrap_stage)
        activated_commit = manifest["commit"]
        print(stage_message, flush=True)
        units, databases = configure_host(
            staged_dir, account, node_bin, selected, os.environ, release_root,
            state_root, backup_dir, log_dir, args.environment,
        )
        managed_units = [*units, CLEANUP_TIMER]
        systemctl("daemon-reload")
        systemctl("enable", *managed_units)

        activate = load_module("agent_bridge_release_activate", staged_dir / "scripts/release-activate.py")
        activate.validate_release(staged_dir, activated_commit, strict=True)
        install_shared_skills(staged_dir, node_bin, account, os.environ)
        bootstrapped_databases = list(databases)
        bootstrap_databases(staged_dir, node_bin, account, selected, databases)
        print(activate.activate(release_root, current, activated_commit), flush=True)

        systemctl("start", *managed_units)
        accept(units, databases, args.acceptance_timeout, state_root)
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
        if release_was_created_by_stage(stage_message) and activated_commit and not (current.is_symlink() and os.readlink(current) == activated_commit):
            discard_staged_release(release_root, activated_commit)
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
