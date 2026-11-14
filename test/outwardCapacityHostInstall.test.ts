import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
      writeFileSync(interactive, "BRIDGE_EXECUTION_MODE=trusted\nCODEX_EXECUTION_MODE=trusted\nCLAUDE_EXECUTION_MODE=safe\nINTERACTIVE_DEFAULT_CLI=claude\n");
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
      expect(result).not.toContain("INTERACTIVE_DEFAULT_CLI=claude");
      writeFileSync(shared, "");
      writeFileSync(interactive, "");
      writeFileSync(bot, "");
      expect(render()).not.toContain("EXECUTION_MODE");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("scopes the protected-host privilege exception to exact managed workspace identity (#1228)", () => {
    const source = readFileSync(installer, "utf8");
    const unit = readFileSync("systemd/agent-bridge-outward-capacity.service", "utf8");
    expect(unit).toContain("NoNewPrivileges=true");
    expect(source).toContain('secure_file "$identity_file"');
    expect(source).toContain('systemctl show agent-bridge-bot.service --property=NoNewPrivileges --value');
    expect(source).toContain('systemctl show agent-bridge-outward-capacity.service --property=NoNewPrivileges --value');
    expect(source).toContain('grep -Eq "^NoNewPrivs:[[:space:]]+$expected_proc_nnp$"');

    const identityStart = source.indexOf("\nis_authorised_protected_host() {");
    const identityEnd = source.indexOf("\n# Preserve the systemd EnvironmentFile", identityStart);
    const policyStart = source.indexOf("\n# The shared OSS template stays restrictive");
    const policyEnd = source.indexOf("\n[[ \"$unit_contents\" == *\"PartOf=agent-bridge-bot.service\"", policyStart);
    expect(identityStart).toBeGreaterThan(-1);
    expect(identityEnd).toBeGreaterThan(identityStart);
    expect(policyStart).toBeGreaterThan(-1);
    expect(policyEnd).toBeGreaterThan(policyStart);

    // Exercise the production identity selector and unit rendering with an
    // injected fixture path; no root paths or systemd state are modified.
    const script = [
      "set -Eeuo pipefail",
      'secure_file() { [[ -f "$1" && ! -L "$1" ]] || exit 2; }',
      'fail() { printf "%s\\n" "$*" >&2; exit 1; }',
      'systemctl() { printf "no\\n"; }',
      source.slice(identityStart, identityEnd),
      'unit_contents="$2"',
      source.slice(policyStart, policyEnd).replace(
        "if is_authorised_protected_host; then", 'if is_authorised_protected_host "$1"; then',
      ),
      'printf "%s\\n" "$unit_contents"',
    ].join("\n");
    const root = mkdtempSync(join(tmpdir(), "outward-host-authority-"));
    try {
      const identity = join(root, "workspace.env");
      const render = (path: string) => execFileSync("bash", ["-c", script, "bash", path, unit], { encoding: "utf8" });
      const restricted = render(identity);
      expect(restricted).toContain("NoNewPrivileges=true");
      expect(restricted).not.toContain("NoNewPrivileges=no");

      writeFileSync(identity, "WORKSPACE_ID=ws_another_customer\\n");
      expect(render(identity)).toContain("NoNewPrivileges=true");
      writeFileSync(identity, "WORKSPACE_ID=ws_71d729ce5ddb3673681a3143bb065cdc\\n");
      const authorised = render(identity);
      expect(authorised).toContain("NoNewPrivileges=no");
      expect(authorised).not.toContain("NoNewPrivileges=true");
      writeFileSync(identity, 'WORKSPACE_ID="ws_71d729ce5ddb3673681a3143bb065cdc"\\n');
      expect(render(identity)).toContain("NoNewPrivileges=no");
      writeFileSync(identity, "WORKSPACE_ID=ws_71d729ce5ddb3673681a3143bb065cdc\\nWORKSPACE_ID=ws_other\\n");
      expect(render(identity)).toContain("NoNewPrivileges=true");

      const alias = join(root, "workspace-link.env");
      symlinkSync(identity, alias);
      expect(() => render(alias)).toThrow();
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
