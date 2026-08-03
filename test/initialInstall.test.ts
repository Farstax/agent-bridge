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
