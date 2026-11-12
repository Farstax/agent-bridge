import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("copies Desk execution modes with correct host precedence and no secrets (#1212)", () => {
    const source = readFileSync(installer, "utf8");
    expect(source).toContain('if [[ -e "$interactive_env" || -L "$interactive_env" ]]; then secure_file "$interactive_env"; fi');
    const start = source.indexOf("\nallowed=(\n");
    const end = source.indexOf("\nscalar() {", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    // Exercise the actual allowlist/copier without writing /etc or invoking systemd.
    const copier = source.slice(start, end);
    const root = mkdtempSync(join(tmpdir(), "outward-worker-mode-"));
    try {
      const shared = join(root, "shared.env");
      const interactive = join(root, "interactive.env");
      const bot = join(root, "bot.env");
      writeFileSync(shared, "BRIDGE_EXECUTION_MODE=safe\nGROK_EXECUTION_MODE=trusted\nTELEGRAM_BOT_TOKEN=do-not-copy\n");
      writeFileSync(interactive, "BRIDGE_EXECUTION_MODE=trusted\nCODEX_EXECUTION_MODE=trusted\nCLAUDE_EXECUTION_MODE=safe\n");
      writeFileSync(bot, "CODEX_EXECUTION_MODE=safe\nCURSOR_EXECUTION_MODE=trusted\nPROVIDER_API_KEY=do-not-copy\n");
      const snippet = [
        "set -Eeuo pipefail",
        'shared_env="$1"',
        'interactive_env="$2"',
        'bot_env="$3"',
        copier,
        'for key in "${allowed[@]}"; do',
        '  if [[ -n "${settings[$key]:-}" ]]; then printf "%s\\n" "${settings[$key]}"; fi',
        "done",
      ].join("\n");
      const render = () => execFileSync("bash", ["-c", snippet, "bash", shared, interactive, bot], { encoding: "utf8" });
      const result = render();
      expect(result).toContain("BRIDGE_EXECUTION_MODE=trusted\n");
      expect(result).toContain("CODEX_EXECUTION_MODE=safe\n");
      expect(result).toContain("CLAUDE_EXECUTION_MODE=safe\n");
      expect(result).toContain("GROK_EXECUTION_MODE=trusted\n");
      expect(result).toContain("CURSOR_EXECUTION_MODE=trusted\n");
      expect(result).not.toContain("TELEGRAM_BOT_TOKEN");
      expect(result).not.toContain("PROVIDER_API_KEY");
      writeFileSync(shared, "");
      writeFileSync(interactive, "");
      writeFileSync(bot, "");
      expect(render()).not.toContain("EXECUTION_MODE");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
