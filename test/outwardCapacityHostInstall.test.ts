import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("outward ACP worker host component (#1181)", () => {
  const installer = "scripts/install-outward-capacity.sh";

  it("passes shell parsing and the zero-byte phased-host-component admission", () => {
    expect(() => execFileSync("bash", ["-n", installer])).not.toThrow();
    expect(execFileSync("bash", [installer, "--print-required-bytes"], { encoding: "utf8" })).toBe("0\n");
  });

  it("reuses the legacy bot's trusted DB and systemd stop/restart lifecycle", () => {
    const source = readFileSync(installer, "utf8");
    expect(source).toContain("unit=agent-bridge-bot.service");
    expect(source).toContain('grep -Fxq "database=$db_path" "$rollout_config"');
    expect(source).toContain("PartOf=agent-bridge-bot.service");
    expect(source).toContain("After=network-online.target agent-bridge-bot.service");
    expect(source).toContain("WantedBy=agent-bridge-bot.service");
    expect(source).toContain("ConditionPathExists=$current_pointer");
    expect(source).toContain('if [[ "$phase" == prepare ]]');
    expect(source).toContain('if [[ "$phase" == converge ]]');
    expect(source).not.toContain("TELEGRAM_BOT_TOKEN");
    expect(source).not.toContain("PROVIDER_API_KEY");
    // The artifact's verify-phase parser requires precisely one literal marker.
    expect(source.match(/printf 'host_component_health=healthy/g)).toHaveLength(1);
  });

  it("preserves the independent existing fresh-install unit", () => {
    const source = readFileSync(installer, "utf8");
    expect(source).toContain('if [[ ! -e "$bot_env" && ! -L "$bot_env" ]]');
    expect(source).toContain("host_component_status=no_op");
    const unit = readFileSync("systemd/agent-bridge-outward-capacity.service", "utf8");
    expect(unit).toContain("User=BRIDGE_USER");
    expect(unit).toContain("EnvironmentFile=/etc/default/agent-bridge-outward-capacity");
    expect(unit).toContain("src/acpServer/continuationWorker.ts");
  });
});
