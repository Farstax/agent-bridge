import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = "scripts/configure-health-mode.py";
const SECRET = "123456:interactive-secret";
const DEFAULT_HEALTH_DB_PATH = "/home/content-crawler/runtime/agent-bridge/health/health.sqlite";

function writeDefaults(root: string, options: { interactiveToken?: string; integrated?: boolean; sharedHealthDbPath?: string } = {}) {
  const defaults = join(root, "defaults");
  mkdirSync(defaults);
  const mode = options.integrated ? "integrated" : "standalone";
  writeFileSync(
    join(defaults, "agent-bridge-shared"),
    `TELEGRAM_ALLOWED_USER_IDS=42\nHEALTH_BOT_MODE=${mode}\n${options.sharedHealthDbPath ? `HEALTH_DB_PATH=${options.sharedHealthDbPath}\n` : ""}`,
    { mode: 0o600 },
  );
  writeFileSync(
    join(defaults, "agent-bridge-interactive"),
    `BRIDGE_ENV_FILE=${defaults}/agent-bridge-interactive\nDB_PATH=/var/lib/agent-bridge/interactive/bridge.sqlite\n${options.interactiveToken === undefined ? `TELEGRAM_BOT_TOKEN_INTERACTIVE=${SECRET}\n` : options.interactiveToken ? `TELEGRAM_BOT_TOKEN_INTERACTIVE=${options.interactiveToken}\n` : ""}${options.integrated ? "HEALTH_DB_PATH=/var/lib/agent-bridge/health/bridge.sqlite\n" : ""}`,
    { mode: 0o600 },
  );
  writeFileSync(
    join(defaults, "agent-bridge-health"),
    `BRIDGE_ENV_FILE=${defaults}/agent-bridge-health\nDB_PATH=/var/lib/agent-bridge/health/bridge.sqlite\nTELEGRAM_BOT_TOKEN_HEALTH=987654:health-secret\n${options.integrated ? `TELEGRAM_BOT_TOKEN_INTERACTIVE=${SECRET}\nHEALTH_DB_PATH=/var/lib/agent-bridge/health/bridge.sqlite\n` : ""}`,
    { mode: 0o600 },
  );
  return defaults;
}

function fakeCommands(root: string) {
  const calls = join(root, "systemctl.log");
  const journalCalls = join(root, "journalctl.log");
  const systemctl = join(root, "systemctl");
  const journalctl = join(root, "journalctl");
  const shared = join(root, "defaults", "agent-bridge-shared");
  writeFileSync(systemctl, `#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> "${calls}"
if [ "$1" = restart ]; then
  [ "\${FAKE_RESTART_FAIL:-0}" != 1 ] || exit 1
  exit 0
fi
if [ "$1" = is-active ]; then
  [ "\${FAKE_ACTIVE_FAIL:-0}" != 1 ] || exit 1
  exit 0
fi
exit 2
`, { mode: 0o755 });
  chmodSync(systemctl, 0o755);
  writeFileSync(journalctl, `#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> "${journalCalls}"
if [[ "$*" == *"--show-cursor"* ]]; then
  echo '-- cursor: fake-restart-cursor'
  exit 0
fi
mode="$(sed -n 's/^HEALTH_BOT_MODE=//p' "${shared}" | tail -n 1)"
if [[ "\${FAKE_STALE_ONLY:-0}" = 1 && "$mode" = integrated ]]; then
  exit 0
fi
case "$*" in
  *agent-bridge-interactive.service*)
    echo '[interactive] starting polling'
    if [[ "\${FAKE_INTERACTIVE_COMMAND_ERROR:-0}" = 1 && "$mode" = integrated ]]; then
      echo '[interactive] setMyCommands (default) failed Error: Telegram unavailable'
    fi
    if [[ "\${FAKE_INTERACTIVE_POLL_ERROR:-0}" = 1 && "$mode" = integrated ]]; then
      echo '[interactive] poll error Error: 409 Conflict'
    fi
    ;;
  *agent-bridge-health.service*)
    if [[ "$mode" = integrated ]]; then
      if [[ "\${FAKE_JOURNAL_BAD:-0}" = 1 ]]; then
        echo '[health-bot] starting...'
      else
        echo '[health-bot] integrated mode: scheduler is send-only; interactive bot owns Telegram polling'
      fi
    else
      echo '[health-bot] starting...'
      if [[ "\${FAKE_HEALTH_POLL_ERROR:-0}" = 1 ]]; then
        echo '[health] polling conflict: another instance is using this bot token; backing off'
      fi
    fi
    ;;
esac
`, { mode: 0o755 });
  chmodSync(journalctl, 0o755);
  return { systemctl, journalctl, calls, journalCalls };
}

function runTransition(defaults: string, commands: ReturnType<typeof fakeCommands>, mode: "integrated" | "standalone", env: NodeJS.ProcessEnv = {}) {
  return spawnSync("python3", [SCRIPT, mode, "--defaults-dir", defaults, "--systemctl", commands.systemctl, "--journalctl", commands.journalctl, "--validation-timeout", "0.1"], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

describe("health bot mode transition", () => {
  it("atomically enables integrated mode without exposing the interactive token", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-health-mode-"));
    const defaults = writeDefaults(root);
    const commands = fakeCommands(root);

    const result = runTransition(defaults, commands, "integrated");

    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toContain(SECRET);
    expect(`${result.stdout}${result.stderr}`).not.toContain("987654:health-secret");
    expect(readFileSync(join(defaults, "agent-bridge-shared"), "utf8")).toContain("HEALTH_BOT_MODE=integrated");
    const health = readFileSync(join(defaults, "agent-bridge-health"), "utf8");
    expect(health).toContain(`TELEGRAM_BOT_TOKEN_INTERACTIVE=${SECRET}`);
    expect(health).toContain(`HEALTH_DB_PATH=${DEFAULT_HEALTH_DB_PATH}`);
    expect(readFileSync(join(defaults, "agent-bridge-interactive"), "utf8")).toContain(`HEALTH_DB_PATH=${DEFAULT_HEALTH_DB_PATH}`);
    expect(statSync(join(defaults, "agent-bridge-health")).mode & 0o777).toBe(0o600);
    expect(statSync(join(defaults, "agent-bridge-interactive")).mode & 0o777).toBe(0o600);
    const calls = readFileSync(commands.calls, "utf8");
    expect(calls).toContain("restart agent-bridge-interactive.service agent-bridge-health.service");
    expect(calls).toContain("is-active --quiet agent-bridge-interactive.service");
    expect(calls).toContain("is-active --quiet agent-bridge-health.service");
    const journalCalls = readFileSync(commands.journalCalls, "utf8");
    expect(journalCalls).toContain("--show-cursor");
    expect(journalCalls).toContain("--after-cursor fake-restart-cursor");
  });

  it("preserves an explicit shared health database path", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-health-mode-db-"));
    const defaults = writeDefaults(root, { sharedHealthDbPath: "/srv/agent-bridge/health.sqlite" });
    const commands = fakeCommands(root);

    const result = runTransition(defaults, commands, "integrated");

    expect(result.status).toBe(0);
    expect(readFileSync(join(defaults, "agent-bridge-health"), "utf8")).toContain("HEALTH_DB_PATH=/srv/agent-bridge/health.sqlite");
    expect(readFileSync(join(defaults, "agent-bridge-interactive"), "utf8")).toContain("HEALTH_DB_PATH=/srv/agent-bridge/health.sqlite");
  });

  it("fails before mutation or restart when the interactive token is unavailable", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-health-mode-preflight-"));
    const defaults = writeDefaults(root, { interactiveToken: "" });
    const commands = fakeCommands(root);
    const before = readFileSync(join(defaults, "agent-bridge-shared"), "utf8");

    const result = runTransition(defaults, commands, "integrated");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("TELEGRAM_BOT_TOKEN_INTERACTIVE is required");
    expect(readFileSync(join(defaults, "agent-bridge-shared"), "utf8")).toBe(before);
    expect(existsSync(commands.calls)).toBe(false);
  });

  it("rejects an interactive polling conflict even when startup markers are present", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-health-mode-conflict-"));
    const defaults = writeDefaults(root);
    const commands = fakeCommands(root);

    const result = runTransition(defaults, commands, "integrated", { FAKE_INTERACTIVE_POLL_ERROR: "1" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("interactive command registration or Telegram polling failed after restart");
    expect(result.stderr).toContain("previous configuration restored");
    expect(readFileSync(join(defaults, "agent-bridge-shared"), "utf8")).toContain("HEALTH_BOT_MODE=standalone");
  });

  it("rejects an interactive command-registration failure", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-health-mode-command-failure-"));
    const defaults = writeDefaults(root);
    const commands = fakeCommands(root);

    const result = runTransition(defaults, commands, "integrated", { FAKE_INTERACTIVE_COMMAND_ERROR: "1" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("interactive command registration or Telegram polling failed after restart");
    expect(result.stderr).toContain("previous configuration restored");
  });

  it("does not accept startup markers that are outside the restart cursor", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-health-mode-stale-log-"));
    const defaults = writeDefaults(root);
    const commands = fakeCommands(root);

    const result = runTransition(defaults, commands, "integrated", { FAKE_STALE_ONLY: "1" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("restart-scoped service logs did not confirm expected polling ownership");
    expect(result.stderr).toContain("previous configuration restored");
  });

  it("restores the exact prior files and validates the restored mode when integrated validation fails", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-health-mode-rollback-"));
    const defaults = writeDefaults(root);
    const commands = fakeCommands(root);
    const paths = ["agent-bridge-shared", "agent-bridge-interactive", "agent-bridge-health"].map((name) => join(defaults, name));
    const before = new Map(paths.map((path) => [path, readFileSync(path, "utf8")]));

    const result = runTransition(defaults, commands, "integrated", { FAKE_JOURNAL_BAD: "1" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("previous configuration restored");
    for (const path of paths) expect(readFileSync(path, "utf8")).toBe(before.get(path));
    const calls = readFileSync(commands.calls, "utf8");
    expect(calls.match(/restart agent-bridge-interactive\.service agent-bridge-health\.service/g)).toHaveLength(2);
    const journalCalls = readFileSync(commands.journalCalls, "utf8");
    expect(journalCalls.match(/--show-cursor/g)).toHaveLength(2);
  });

  it("validates standalone health polling and rolls back when it conflicts", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-health-mode-standalone-conflict-"));
    const defaults = writeDefaults(root, { integrated: true });
    const commands = fakeCommands(root);

    const result = runTransition(defaults, commands, "standalone", { FAKE_HEALTH_POLL_ERROR: "1" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("health command registration or Telegram polling failed after restart");
    expect(result.stderr).toContain("previous configuration restored");
    expect(readFileSync(join(defaults, "agent-bridge-shared"), "utf8")).toContain("HEALTH_BOT_MODE=integrated");
  });

  it("switches back to standalone mode while preserving health state", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-health-mode-standalone-"));
    const defaults = writeDefaults(root, { integrated: true });
    const commands = fakeCommands(root);

    const result = runTransition(defaults, commands, "standalone");

    expect(result.status).toBe(0);
    expect(readFileSync(join(defaults, "agent-bridge-shared"), "utf8")).toContain("HEALTH_BOT_MODE=standalone");
    const health = readFileSync(join(defaults, "agent-bridge-health"), "utf8");
    expect(health).not.toContain("TELEGRAM_BOT_TOKEN_INTERACTIVE=");
    expect(health).toContain("HEALTH_DB_PATH=/var/lib/agent-bridge/health/bridge.sqlite");
    expect(readFileSync(join(defaults, "agent-bridge-interactive"), "utf8")).not.toContain("HEALTH_DB_PATH=");
  });

  it("refuses defaults symlinks before touching services", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-health-mode-symlink-"));
    const defaults = writeDefaults(root);
    const commands = fakeCommands(root);
    const shared = join(defaults, "agent-bridge-shared");
    const target = join(root, "shared-target");
    const current = readFileSync(shared, "utf8");
    writeFileSync(target, current, { mode: 0o600 });
    unlinkSync(shared);
    symlinkSync(target, shared);

    const result = runTransition(defaults, commands, "integrated");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("not a symlink");
    expect(existsSync(commands.calls)).toBe(false);
  });
});
