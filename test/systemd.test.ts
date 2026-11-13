import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("systemd templates", () => {
  it("requires every service to resolve code through the controlled current pointer", () => {
    const units = [
      "agent-bridge-discord-interactive.service",
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

  it("loads shared configuration before each supported service environment", () => {
    for (const name of ["interactive", "discord-interactive"]) {
      const content = readFileSync(new URL(`../systemd/agent-bridge-${name}.service`, import.meta.url), "utf8");
      const shared = content.indexOf("EnvironmentFile=-/etc/default/agent-bridge-shared");
      const surface = content.indexOf(`EnvironmentFile=/etc/default/agent-bridge-${name}`);
      expect(shared, name).toBeGreaterThanOrEqual(0);
      expect(surface, name).toBeGreaterThan(shared);
    }
  });

  it(".env.shared.example exists with shared vars", () => {
    const shared = readFileSync(new URL("../.env.shared.example", import.meta.url), "utf8");
    expect(shared).toContain("AGENT_BRIDGE_SENSOR_CONFIG");
    expect(shared).not.toContain("HEALTH_MONITOR_ENABLED");
    expect(shared).toContain("TELEGRAM_ALLOWED_USER_IDS");
    expect(shared).toContain("BRIDGE_ROOT_DIR");
    expect(shared).toContain("NODE_BIN");
  });

  it("ships no Advisor configuration in the shared environment example", () => {
    const shared = readFileSync(new URL("../.env.shared.example", import.meta.url), "utf8");
    expect(shared).not.toMatch(/ADVISOR/i);
  });

  it("uses KillMode=control-group in each supported service", () => {
    for (const name of ["interactive", "discord-interactive"]) {
      const content = readFileSync(new URL(`../systemd/agent-bridge-${name}.service`, import.meta.url), "utf8");
      expect(content).toContain("KillMode=control-group");
    }
  });

  it("keeps workspace locking off for canonical interactive services", () => {
    for (const name of ["interactive", "discord-interactive"]) {
      const content = readFileSync(new URL(`../systemd/agent-bridge-${name}.service`, import.meta.url), "utf8");
      expect(content).toContain("Environment=BRIDGE_WORKSPACE_LOCK_MODE=off");
    }
  });

  it("requires a patched Node runtime and records it for services", () => {
    const install = readFileSync(new URL("../scripts/install.sh", import.meta.url), "utf8");

    expect(install).toContain("NODE_SECURITY_FLOORS=\"24.22.1 26.12.1\"");
    expect(install).toContain("node_version_admitted \"${version}\"");
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
    expect(service).toContain("/etc/default/agent-bridge-interactive");
    // Both paths are installed by existing supported interactive provisioning.
    // The capacity DB is a fallback; explicit interactive config wins.
    expect(service).toContain("EnvironmentFile=-/etc/default/agent-bridge-outward-capacity");
    expect(service.indexOf("agent-bridge-outward-capacity")).toBeLessThan(service.indexOf("EnvironmentFile=-/etc/default/agent-bridge-interactive"));
    expect(service).toContain("REAP_REQUIRE_INTERACTIVE_DB=1");
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
