import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const installer = resolve(process.cwd(), "scripts/agent-bridge-install.py");

function probe(body: string): unknown {
  const source = `
import importlib.util, json, pathlib, sys, tempfile
path = pathlib.Path(${JSON.stringify(installer)})
spec = importlib.util.spec_from_file_location("agent_bridge_install_test", path)
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
${body}
`;
  return JSON.parse(execFileSync("python3", ["-c", source], { encoding: "utf8" }));
}

describe("exact-release initial installer", () => {
  it("selects configured services and keeps their databases outside releases", () => {
    const result = probe(`
services = module.selected_services({
  "TELEGRAM_BOT_TOKEN_INTERACTIVE": "telegram-token",
  "DISCORD_BOT_TOKEN": "discord-token",
  "DISCORD_APPLICATION_ID": "application-id",
})
state = pathlib.Path("/var/lib/agent-bridge")
releases = pathlib.Path("/opt/agent-bridge/releases")
print(json.dumps({
  "units": [service[0] for service in services],
  "databases": [str(module.database_path(state, service)) for service in services],
  "inside": [module.database_path(state, service).is_relative_to(releases) for service in services],
}))
`) as { units: string[]; databases: string[]; inside: boolean[] };

    expect(result.units).toEqual([
      "agent-bridge-interactive.service",
      "agent-bridge-discord-interactive.service",
    ]);
    expect(result.databases).toEqual([
      "/var/lib/agent-bridge/interactive/bridge.sqlite",
      "/var/lib/agent-bridge/discord-interactive/bridge.sqlite",
    ]);
    expect(result.inside).toEqual([false, false]);
  });

  it("bootstraps every selected fresh database with its fixed database role", () => {
    const result = probe(`
calls = []
def fake_run(command, **kwargs):
  calls.append(command)
  return None
module.subprocess.run = fake_run
account = type("Account", (), {"pw_name": "agentbridge"})()
services = module.selected_services({
  "TELEGRAM_BOT_TOKEN_CODEX": "codex-token",
  "TELEGRAM_BOT_TOKEN_INTERACTIVE": "interactive-token",
  "TELEGRAM_BOT_TOKEN_HEALTH": "health-token",
})
paths = [module.database_path(pathlib.Path("/var/lib/agent-bridge"), service) for service in services]
with tempfile.TemporaryDirectory() as directory:
  release = pathlib.Path(directory) / "release"
  (release / "node_modules/tsx/dist").mkdir(parents=True)
  (release / "scripts").mkdir()
  (release / "node_modules/tsx/dist/cli.mjs").write_text("runtime")
  (release / "scripts/rollout-db.ts").write_text("bootstrap")
  module.bootstrap_databases(release, pathlib.Path("/usr/bin/node"), account, services, paths)
print(json.dumps({"calls": calls}))
`) as { calls: string[][] };

    expect(result.calls).toEqual([
      [
        "/usr/sbin/runuser", "--user", "agentbridge", "--", "/usr/bin/node",
        expect.stringMatching(/\/release\/node_modules\/tsx\/dist\/cli\.mjs$/), expect.stringMatching(/\/release\/scripts\/rollout-db\.ts$/), "bootstrap",
        "--db", "/var/lib/agent-bridge/codex/bridge.sqlite", "--role", "shared",
        "--confirm-new-role", "/var/lib/agent-bridge/codex/bridge.sqlite",
      ],
      [
        "/usr/sbin/runuser", "--user", "agentbridge", "--", "/usr/bin/node",
        expect.stringMatching(/\/release\/node_modules\/tsx\/dist\/cli\.mjs$/), expect.stringMatching(/\/release\/scripts\/rollout-db\.ts$/), "bootstrap",
        "--db", "/var/lib/agent-bridge/interactive/bridge.sqlite", "--role", "interactive",
        "--confirm-new-role", "/var/lib/agent-bridge/interactive/bridge.sqlite",
      ],
      [
        "/usr/sbin/runuser", "--user", "agentbridge", "--", "/usr/bin/node",
        expect.stringMatching(/\/release\/node_modules\/tsx\/dist\/cli\.mjs$/), expect.stringMatching(/\/release\/scripts\/rollout-db\.ts$/), "bootstrap",
        "--db", "/var/lib/agent-bridge/health/bridge.sqlite", "--role", "health",
        "--confirm-new-role", "/var/lib/agent-bridge/health/bridge.sqlite",
      ],
    ]);
  });

  it("refuses an initial install over an existing persistent database", () => {
    const result = probe(`
with tempfile.TemporaryDirectory() as directory:
  state = pathlib.Path(directory)
  service = module.selected_services({"TELEGRAM_BOT_TOKEN_INTERACTIVE": "token"})[0]
  target = module.database_path(state, service)
  target.parent.mkdir(parents=True)
  target.write_text("existing-state", encoding="utf-8")
  try:
    module.require_fresh_database_targets(state, [service])
  except Exception as error:
    print(json.dumps({"error": str(error), "contents": target.read_text(encoding="utf-8")}))
`) as { error: string; contents: string };

    expect(result.error).toContain("persistent database targets already exist");
    expect(result.contents).toBe("existing-state");
  });

  it("renders the fixed rollout inventory with helper identities", () => {
    const result = probe(`
with tempfile.TemporaryDirectory() as directory:
  root = pathlib.Path(directory)
  helpers = {}
  for name in ("rollout", "activate", "authorization", "acceptance", "stage", "restore"):
    path = root / name
    path.write_text(name, encoding="utf-8")
    helpers[name] = path
  rendered = module.render_rollout_config(
    pathlib.Path("/opt/agent-bridge/releases"), "production-agent-bridge", "agentbridge",
    pathlib.Path("/usr/bin/node"), ["agent-bridge-interactive.service"],
    [pathlib.Path("/var/lib/agent-bridge/interactive/bridge.sqlite")], helpers,
  )
  print(json.dumps({"rendered": rendered}))
`) as { rendered: string };

    expect(result.rendered).toContain("current_pointer=/opt/agent-bridge/releases/current");
    expect(result.rendered).toContain("unit=agent-bridge-interactive.service");
    expect(result.rendered).toContain("database=/var/lib/agent-bridge/interactive/bridge.sqlite");
    expect(result.rendered).toMatch(/rollout_helper_sha256=[0-9a-f]{64}/);
  });

  it("accepts timer files without a service user placeholder", () => {
    const result = probe(`
print(json.dumps({
  "timer": module.render_systemd_file("agent-bridge-tmp-cleanup.timer", "[Timer]\\n", "agentbridge"),
  "service": module.render_systemd_file("agent-bridge-codex.service", "User=BRIDGE_USER\\n", "agentbridge"),
}))
`) as { timer: string; service: string };

    expect(result.timer).toBe("[Timer]\n");
    expect(result.service).toBe("User=agentbridge\n");
  });

  it("reports a clean failure message on stderr when run as non-root", () => {
    let stderr = "";
    let status = 0;
    try {
      execFileSync("python3", [
        installer,
        "--release", "/nonexistent/release.tar.gz",
        "--runtime-user", "agentbridge",
        "--node-bin", "/usr/bin/node",
      ], { encoding: "utf8" });
    } catch (error) {
      const failure = error as { status?: number; stderr?: string };
      status = failure.status ?? 0;
      stderr = failure.stderr ?? "";
    }

    expect(status).toBe(1);
    expect(stderr).toContain("agent-bridge-install: agent-bridge-install must run as root");
    expect(stderr).not.toContain("NameError");
  });

  it("requires a Discord application id", () => {
    const result = probe(`
try:
  module.selected_services({"DISCORD_BOT_TOKEN": "discord-token"})
except Exception as error:
  print(json.dumps({"error": str(error)}))
`) as { error: string };

    expect(result.error).toBe("DISCORD_APPLICATION_ID is required with DISCORD_BOT_TOKEN");
  });
});
