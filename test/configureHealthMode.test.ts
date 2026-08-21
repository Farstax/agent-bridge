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
  const systemctl = join(root, "systemctl");
  const journalctl = join(root, "journalctl");
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
case "$*" in
  *agent-bridge-interactive.service*)
    echo '[interactive] starting polling'
    ;;
  *agent-bridge-health.service*)
    if [ "\${FAKE_JOURNAL_BAD:-0}" = 1 ]; then
      echo '[health-bot] starting...'
    elif [ "\${FAKE_STANDALONE:-0}" = 1 ]; then
      echo '[health-bot] starting...'
    else
      echo '[health-bot] integrated mode: scheduler is send-only; interactive bot owns Telegram polling'
    fi
    ;;
esac
`, { mode: 0o755 });
  chmodSync(journalctl, 0o755);
  return { systemctl, journalctl, calls };
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

  it("restores the exact prior files and healthy services when integrated validation fails", () => {
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
  });

  it("switches back to standalone mode while preserving health state", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-health-mode-standalone-"));
    const defaults = writeDefaults(root, { integrated: true });
    const commands = fakeCommands(root);

    const result = runTransition(defaults, commands, "standalone", { FAKE_STANDALONE: "1" });

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
