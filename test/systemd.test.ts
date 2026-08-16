import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("systemd templates", () => {
  it("pin service-specific env files and absolute CLI paths", () => {
    const codex = readFileSync(new URL("../systemd/agent-bridge-codex.service", import.meta.url), "utf8");
    const antigravity = readFileSync(new URL("../systemd/agent-bridge-antigravity.service", import.meta.url), "utf8");

    expect(codex).toContain("EnvironmentFile=/etc/default/agent-bridge-codex");
    expect(antigravity).toContain("EnvironmentFile=/etc/default/agent-bridge-antigravity");
    expect(codex).toContain("User=BRIDGE_USER");
    expect(antigravity).toContain("User=BRIDGE_USER");
    expect(codex).toContain('export PATH="$(dirname "${NODE_BIN:?}"):$PATH"');
    expect(antigravity).toContain('export PATH="$(dirname "${NODE_BIN:?}"):$PATH"');
    expect(codex).toContain('cd "${BRIDGE_CURRENT_RELEASE_DIR:?}"');
    expect(antigravity).toContain('cd "${BRIDGE_CURRENT_RELEASE_DIR:?}"');
  });

  it("requires every service to resolve code through the controlled current pointer", () => {
    const units = [
      "agent-bridge-antigravity.service",
      "agent-bridge-claude.service",
      "agent-bridge-codex.service",
      "agent-bridge-discord-interactive.service",
      "agent-bridge-health.service",
      "agent-bridge-interactive.service",
    ];

    for (const unit of units) {
      const content = readFileSync(new URL(`../systemd/${unit}`, import.meta.url), "utf8");
      expect(content, unit).toContain("EnvironmentFile=/etc/default/agent-bridge-release");
      expect(content, unit).toContain('[[ -L "${BRIDGE_CURRENT_RELEASE_DIR:?}" ]]');
      expect(content, unit).toContain('export BRIDGE_PROJECT_DIR="${BRIDGE_CURRENT_RELEASE_DIR:?}"');
      expect(content, unit).toContain('cd "${BRIDGE_CURRENT_RELEASE_DIR:?}"');
    }
  });

  it("all service templates load shared env file before bot-specific", () => {
    const codex = readFileSync(new URL("../systemd/agent-bridge-codex.service", import.meta.url), "utf8");
    const antigravity = readFileSync(new URL("../systemd/agent-bridge-antigravity.service", import.meta.url), "utf8");
    const claude = readFileSync(new URL("../systemd/agent-bridge-claude.service", import.meta.url), "utf8");

    for (const [name, content] of [["codex", codex], ["antigravity", antigravity], ["claude", claude]] as const) {
      expect(content, name).toContain("EnvironmentFile=-/etc/default/agent-bridge-shared");
      const sharedIdx = content.indexOf("EnvironmentFile=-/etc/default/agent-bridge-shared");
      const specificIdx = content.indexOf(`EnvironmentFile=/etc/default/agent-bridge-${name}`);
      expect(sharedIdx, `${name}: shared before specific`).toBeLessThan(specificIdx);
    }
  });

  it(".env.shared.example exists with shared vars", () => {
    const shared = readFileSync(new URL("../.env.shared.example", import.meta.url), "utf8");
    expect(shared).toContain("HEALTH_MONITOR_ENABLED");
    expect(shared).toContain("TELEGRAM_ALLOWED_USER_IDS");
    expect(shared).toContain("BRIDGE_ROOT_DIR");
    expect(shared).toContain("NODE_BIN");
  });

  it("projects Claude Opus 5 as the primary advisor with Codex GPT-5.6 Sol fallback", () => {
    // Fable 5 was unsuitable as the configured advisor; a fresh install
    // (scripts/install.sh copies this file verbatim into .env.shared when
    // no override already exists) must default new deployments to Opus 5.
    const shared = readFileSync(new URL("../.env.shared.example", import.meta.url), "utf8");
    expect(shared).toContain("BRIDGE_ADVISOR_CHAIN=claude:claude-opus-5,codex:gpt-5.6-sol");
    expect(shared).not.toContain("claude-fable-5");
  });

  it("all service templates include KillMode=control-group", () => {
    const codex = readFileSync(new URL("../systemd/agent-bridge-codex.service", import.meta.url), "utf8");
    const antigravity = readFileSync(new URL("../systemd/agent-bridge-antigravity.service", import.meta.url), "utf8");
    const claude = readFileSync(new URL("../systemd/agent-bridge-claude.service", import.meta.url), "utf8");
    expect(codex).toContain("KillMode=control-group");
    expect(antigravity).toContain("KillMode=control-group");
    expect(claude).toContain("KillMode=control-group");
  });

  it("keeps workspace locking off for shared canonical-checkout services", () => {
    const codex = readFileSync(new URL("../systemd/agent-bridge-codex.service", import.meta.url), "utf8");
    const antigravity = readFileSync(new URL("../systemd/agent-bridge-antigravity.service", import.meta.url), "utf8");
    const claude = readFileSync(new URL("../systemd/agent-bridge-claude.service", import.meta.url), "utf8");
    const interactive = readFileSync(new URL("../systemd/agent-bridge-interactive.service", import.meta.url), "utf8");
    const discord = readFileSync(new URL("../systemd/agent-bridge-discord-interactive.service", import.meta.url), "utf8");

    for (const [name, content] of [["codex", codex], ["antigravity", antigravity], ["claude", claude], ["interactive", interactive], ["discord", discord]] as const) {
      expect(content, name).toContain("Environment=BRIDGE_WORKSPACE_LOCK_MODE=off");
    }
  });

  it("requires and records Node 24+ for service runtime", () => {
    const install = readFileSync(new URL("../scripts/install.sh", import.meta.url), "utf8");

    expect(install).toContain("NODE_MIN_MAJOR=24");
    expect(install).toContain("NODE_BIN=${NODE_BIN}");
    expect(install).toContain('"${NODE_BIN}" ./node_modules/tsx/dist/cli.mjs');
  });

  it("installs an explicit active-release pointer configuration", () => {
    const install = readFileSync(new URL("../scripts/install.sh", import.meta.url), "utf8");
    const example = readFileSync(new URL("../systemd/agent-bridge-release.conf.example", import.meta.url), "utf8");

    expect(install).toContain("BRIDGE_CURRENT_RELEASE_DIR");
    expect(install).toContain('"/opt/agent-bridge/releases/current"');
    expect(install).not.toContain("systemctl enable --now");
    expect(install).toContain('local dest="${DEFAULTS_DIR}/agent-bridge-release"');
    expect(example).toContain("BRIDGE_CURRENT_RELEASE_DIR=/opt/agent-bridge/releases/current");
    expect(example).not.toContain("/agent-bridge/.git");
  });

  it("install script does not write retired Telegram Markdown IR defaults", () => {
    const install = readFileSync(new URL("../scripts/install.sh", import.meta.url), "utf8");

    expect(install).not.toContain("ensure_markdown_ir_default");
    expect(install).not.toContain("TELEGRAM_MARKDOWN_IR_ENABLED");
  });

  it("tmp-cleanup service runs the reaper script from the immutable current release", () => {
    const service = readFileSync(new URL("../systemd/agent-bridge-tmp-cleanup.service", import.meta.url), "utf8");

    expect(service).toContain("Type=oneshot");
    expect(service).toContain("User=BRIDGE_USER");
    expect(service).toContain("EnvironmentFile=/etc/default/agent-bridge-release");
    expect(service).toContain("BRIDGE_CURRENT_RELEASE_DIR");
    expect(service).toContain("scripts/reap-tmp-artifacts.sh");
    expect(service).not.toContain("BRIDGE_REPO_DIR/scripts");
  });

  it("tmp-cleanup timer runs daily and catches up after downtime", () => {
    const timer = readFileSync(new URL("../systemd/agent-bridge-tmp-cleanup.timer", import.meta.url), "utf8");

    expect(timer).toContain("OnCalendar=");
    expect(timer).toContain("Persistent=true");
    expect(timer).toContain("WantedBy=timers.target");
  });

  it("install.sh and upgrade.sh install and enable the tmp-cleanup service and timer", () => {
    const install = readFileSync(new URL("../scripts/install.sh", import.meta.url), "utf8");
    const upgrade = readFileSync(new URL("../scripts/upgrade.sh", import.meta.url), "utf8");

    for (const [name, content] of [["install.sh", install], ["upgrade.sh", upgrade]] as const) {
      expect(content, name).toContain("install_unit agent-bridge-tmp-cleanup");
      expect(content, name).toContain("install_timer agent-bridge-tmp-cleanup");
      expect(content, name).toContain("agent-bridge-tmp-cleanup.timer");
      expect(content, name).toMatch(/UNITS_TO_ENABLE=.*agent-bridge-tmp-cleanup\.timer/);
      expect(content, name).toMatch(/systemctl enable[^\n]*UNITS_TO_ENABLE/);
    }
  });

});
