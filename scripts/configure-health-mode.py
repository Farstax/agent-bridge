#!/usr/bin/env python3
"""Safely switch an installed Agent Bridge health bot between standalone and integrated mode."""

from __future__ import annotations

import argparse
import os
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Mapping

DEFAULTS_DIR = Path("/etc/default")
DEFAULT_HEALTH_DB_PATH = "/home/content-crawler/runtime/agent-bridge/health/health.sqlite"
INTERACTIVE_UNIT = "agent-bridge-interactive.service"
HEALTH_UNIT = "agent-bridge-health.service"
UNITS = (INTERACTIVE_UNIT, HEALTH_UNIT)
INTEGRATED_HEALTH_LOG = "integrated mode: scheduler is send-only; interactive bot owns Telegram polling"
INTERACTIVE_POLL_LOG = "[interactive] starting polling"
HEALTH_START_LOG = "[health-bot] starting..."
HEALTH_FAILURE_LOGS = ("[health-bot] setMyCommands failed", "[health] polling conflict:", "[health] polling failed")


class TransitionError(RuntimeError):
    pass


def read_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        if key and key.replace("_", "A").isalnum():
            values[key] = value
    return values


def update_env_text(text: str, changes: Mapping[str, str], removals: set[str] | None = None) -> str:
    removals = removals or set()
    emitted: set[str] = set()
    output: list[str] = []
    for raw_line in text.splitlines():
        if "=" in raw_line and not raw_line.lstrip().startswith("#"):
            key = raw_line.split("=", 1)[0]
            if key in removals:
                continue
            if key in changes:
                if key not in emitted:
                    output.append(f"{key}={changes[key]}")
                    emitted.add(key)
                continue
        output.append(raw_line)
    for key, value in changes.items():
        if key not in emitted:
            output.append(f"{key}={value}")
    return "\n".join(output) + "\n"


def require_regular_file(path: Path) -> os.stat_result:
    try:
        info = path.lstat()
    except FileNotFoundError as error:
        raise TransitionError(f"required defaults file is missing: {path}") from error
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        raise TransitionError(f"defaults path must be a regular file, not a symlink: {path}")
    return info


def atomic_write(path: Path, text: str, owner: os.stat_result, mode: int = 0o600) -> None:
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temp_path = Path(temp_name)
    try:
        os.fchmod(fd, mode)
        if os.geteuid() == 0:
            os.fchown(fd, owner.st_uid, owner.st_gid)
        with os.fdopen(fd, "wb", closefd=True) as stream:
            stream.write(text.encode("utf-8"))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp_path, path)
        dir_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)
    finally:
        if temp_path.exists():
            temp_path.unlink()


def run(command: list[str], *, capture: bool = False) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        check=False,
        text=True,
        stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
        stderr=subprocess.PIPE if capture else subprocess.DEVNULL,
    )


def restart_services(systemctl: str) -> None:
    result = run([systemctl, "restart", *UNITS], capture=True)
    if result.returncode != 0:
        raise TransitionError("failed to restart interactive and health services")


def wait_active(systemctl: str, timeout_seconds: float) -> None:
    deadline = time.monotonic() + timeout_seconds
    pending = set(UNITS)
    while pending:
        for unit in tuple(pending):
            if run([systemctl, "is-active", "--quiet", unit]).returncode == 0:
                pending.remove(unit)
        if not pending:
            return
        if time.monotonic() >= deadline:
            raise TransitionError(f"services did not become active: {', '.join(sorted(pending))}")
        time.sleep(min(0.25, max(0.01, timeout_seconds / 10)))


def journal_cursor(journalctl: str) -> str:
    result = run([journalctl, "--no-pager", "-n", "0", "--show-cursor"], capture=True)
    if result.returncode != 0:
        raise TransitionError("unable to capture journal cursor before service restart")
    for line in reversed(result.stdout.splitlines()):
        prefix = "-- cursor: "
        if line.startswith(prefix) and line[len(prefix):].strip():
            return line[len(prefix):].strip()
    raise TransitionError("journalctl did not return a restart-scoped cursor")


def journal_after_cursor(journalctl: str, unit: str, cursor: str) -> str:
    result = run(
        [journalctl, "-u", unit, "--after-cursor", cursor, "--no-pager", "-n", "200"],
        capture=True,
    )
    if result.returncode != 0:
        raise TransitionError(f"unable to read restart-scoped service logs for {unit}")
    return result.stdout


def validation_failure(interactive_log: str, health_log: str) -> str | None:
    interactive_command_failed = "[interactive] setMyCommands (" in interactive_log and " failed" in interactive_log
    if "[interactive] poll error" in interactive_log or interactive_command_failed:
        return "interactive command registration or Telegram polling failed after restart"
    for marker in HEALTH_FAILURE_LOGS:
        if marker in health_log:
            return "health command registration or Telegram polling failed after restart"
    return None


def wait_for_service_validation(
    systemctl: str,
    journalctl: str,
    cursor: str,
    mode: str,
    timeout_seconds: float,
) -> None:
    deadline = time.monotonic() + timeout_seconds
    markers_seen = False
    while True:
        inactive = [unit for unit in UNITS if run([systemctl, "is-active", "--quiet", unit]).returncode != 0]
        if inactive:
            raise TransitionError(f"services became inactive during validation: {', '.join(inactive)}")

        interactive_log = journal_after_cursor(journalctl, INTERACTIVE_UNIT, cursor)
        health_log = journal_after_cursor(journalctl, HEALTH_UNIT, cursor)
        failure = validation_failure(interactive_log, health_log)
        if failure:
            raise TransitionError(failure)

        interactive_ok = INTERACTIVE_POLL_LOG in interactive_log
        health_ok = (
            INTEGRATED_HEALTH_LOG in health_log
            if mode == "integrated"
            else HEALTH_START_LOG in health_log and INTEGRATED_HEALTH_LOG not in health_log
        )
        markers_seen = markers_seen or (interactive_ok and health_ok)

        if time.monotonic() >= deadline:
            if markers_seen:
                return
            expected = (
                "integrated send-only health / interactive polling"
                if mode == "integrated"
                else "standalone health polling / interactive polling"
            )
            raise TransitionError(f"restart-scoped service logs did not confirm expected polling ownership: {expected}")
        time.sleep(min(0.25, max(0.01, timeout_seconds / 10)))


def transition(mode: str, defaults_dir: Path, systemctl: str, journalctl: str, timeout_seconds: float) -> None:
    shared = defaults_dir / "agent-bridge-shared"
    interactive = defaults_dir / "agent-bridge-interactive"
    health = defaults_dir / "agent-bridge-health"
    paths = (shared, interactive, health)
    stats = {path: require_regular_file(path) for path in paths}
    originals = {path: path.read_text(encoding="utf-8") for path in paths}

    shared_values = read_env(shared)
    interactive_values = read_env(interactive)
    health_values = read_env(health)
    previous_mode = (shared_values.get("HEALTH_BOT_MODE") or "standalone").strip()
    if previous_mode not in {"standalone", "integrated"}:
        raise TransitionError(f"unsupported existing HEALTH_BOT_MODE: {previous_mode}")

    if mode == "integrated":
        interactive_token = interactive_values.get("TELEGRAM_BOT_TOKEN_INTERACTIVE", "").strip()
        if not interactive_token:
            raise TransitionError("TELEGRAM_BOT_TOKEN_INTERACTIVE is required in agent-bridge-interactive before enabling integrated health")
        # Mirror src/index-health.ts. Generic DB_PATH is deliberately ignored.
        health_db_path = (
            health_values.get("HEALTH_DB_PATH")
            or shared_values.get("HEALTH_DB_PATH")
            or DEFAULT_HEALTH_DB_PATH
        ).strip()
        replacements = {
            shared: update_env_text(originals[shared], {"HEALTH_BOT_MODE": "integrated"}),
            interactive: update_env_text(originals[interactive], {"HEALTH_DB_PATH": health_db_path}),
            health: update_env_text(
                originals[health],
                {"TELEGRAM_BOT_TOKEN_INTERACTIVE": interactive_token, "HEALTH_DB_PATH": health_db_path},
            ),
        }
    else:
        health_token = health_values.get("TELEGRAM_BOT_TOKEN_HEALTH", "").strip()
        if not health_token:
            raise TransitionError("TELEGRAM_BOT_TOKEN_HEALTH is required in agent-bridge-health before enabling standalone health")
        replacements = {
            shared: update_env_text(originals[shared], {"HEALTH_BOT_MODE": "standalone"}),
            interactive: update_env_text(originals[interactive], {}, {"HEALTH_DB_PATH"}),
            health: update_env_text(originals[health], {}, {"TELEGRAM_BOT_TOKEN_INTERACTIVE"}),
        }

    mutation_started = False
    try:
        mutation_started = True
        for path in paths:
            atomic_write(path, replacements[path], stats[path], 0o600)
        cursor = journal_cursor(journalctl)
        restart_services(systemctl)
        wait_active(systemctl, timeout_seconds)
        wait_for_service_validation(systemctl, journalctl, cursor, mode, timeout_seconds)
    except Exception as error:
        if mutation_started:
            rollback_error: Exception | None = None
            try:
                for path in paths:
                    atomic_write(path, originals[path], stats[path], stat.S_IMODE(stats[path].st_mode))
                rollback_cursor = journal_cursor(journalctl)
                restart_services(systemctl)
                wait_active(systemctl, timeout_seconds)
                wait_for_service_validation(systemctl, journalctl, rollback_cursor, previous_mode, timeout_seconds)
            except Exception as restore_error:  # pragma: no cover - catastrophic host failure
                rollback_error = restore_error
            if rollback_error is not None:
                raise TransitionError(f"transition failed and rollback could not restore healthy services: {rollback_error}") from error
            raise TransitionError(f"transition failed; previous configuration restored: {error}") from error
        raise


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Safely switch Agent Bridge health bot mode")
    parser.add_argument("mode", choices=("standalone", "integrated"))
    parser.add_argument("--defaults-dir", type=Path, default=DEFAULTS_DIR)
    parser.add_argument("--systemctl", default="/usr/bin/systemctl")
    parser.add_argument("--journalctl", default="/usr/bin/journalctl")
    parser.add_argument("--validation-timeout", type=float, default=15.0)
    args = parser.parse_args(argv)
    if args.validation_timeout <= 0:
        parser.error("--validation-timeout must be greater than zero")
    return args


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    try:
        transition(args.mode, args.defaults_dir, args.systemctl, args.journalctl, args.validation_timeout)
    except TransitionError as error:
        print(f"health mode transition failed: {error}", file=sys.stderr)
        return 1
    print(f"health mode transition complete: {args.mode}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
