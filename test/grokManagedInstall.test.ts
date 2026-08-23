import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const installer = resolve(process.cwd(), "scripts/agent-bridge-install.py");

function probe(body: string): unknown {
  const source = `
import importlib.util, json, pathlib, sys
path = pathlib.Path(${JSON.stringify(installer)})
spec = importlib.util.spec_from_file_location("agent_bridge_install_grok_test", path)
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
${body}
`;
  return JSON.parse(execFileSync("python3", ["-c", source], { encoding: "utf8" }));
}

describe("managed Grok provider installation", () => {
  it("selects an isolated Grok service and propagates Grok runtime configuration", () => {
    const result = probe(`
env = {
  "TELEGRAM_BOT_TOKEN_GROK": "grok-telegram-token",
  "GROK_COMMAND": "/home/agentbridge/.grok/bin/grok",
  "GROK_MODEL_PREFERENCE": "grok-build",
  "GROK_EFFORT": "high",
  "GROK_PROJECT_DIR": "/srv/workspace",
  "XAI_API_KEY": "xai-secret",
}
services = module.selected_services(env)
grok = services[0]
values = module.service_values(
  env,
  pathlib.Path("/etc/default/agent-bridge-grok"),
  pathlib.Path("/var/lib/agent-bridge/grok/bridge.sqlite"),
  grok[2],
)
print(json.dumps({
  "service": list(grok),
  "database": str(module.database_path(pathlib.Path("/var/lib/agent-bridge"), grok)),
  "role": module.DATABASE_ROLES[grok[3]],
  "values": values,
}))
`) as {
      service: [string, string, string[], string];
      database: string;
      role: string;
      values: Record<string, string>;
    };

    expect(result.service).toEqual([
      "agent-bridge-grok.service",
      "agent-bridge-grok",
      ["TELEGRAM_BOT_TOKEN_GROK"],
      "grok",
    ]);
    expect(result.database).toBe("/var/lib/agent-bridge/grok/bridge.sqlite");
    expect(result.role).toBe("shared");
    expect(result.values).toMatchObject({
      TELEGRAM_BOT_TOKEN_GROK: "grok-telegram-token",
      GROK_COMMAND: "/home/agentbridge/.grok/bin/grok",
      GROK_MODEL_PREFERENCE: "grok-build",
      GROK_EFFORT: "high",
      GROK_PROJECT_DIR: "/srv/workspace",
      XAI_API_KEY: "xai-secret",
    });
  });

  it("does not leak Grok Telegram or API credentials into other provider defaults", () => {
    const result = probe(`
env = {
  "TELEGRAM_BOT_TOKEN_CODEX": "codex-token",
  "TELEGRAM_BOT_TOKEN_GROK": "grok-token",
  "XAI_API_KEY": "xai-secret",
}
services = module.selected_services(env)
codex = next(service for service in services if service[3] == "codex")
values = module.service_values(
  env,
  pathlib.Path("/etc/default/agent-bridge-codex"),
  pathlib.Path("/var/lib/agent-bridge/codex/bridge.sqlite"),
  codex[2],
)
print(json.dumps({"values": values}))
`) as { values: Record<string, string> };

    expect(result.values.TELEGRAM_BOT_TOKEN_GROK).toBeUndefined();
    expect(result.values.XAI_API_KEY).toBeUndefined();
  });

  it("ships the locked Grok systemd unit in the release artifact inventory", () => {
    const unit = readFileSync(resolve(process.cwd(), "systemd/agent-bridge-grok.service"), "utf8");
    const releaseWorkflow = readFileSync(resolve(process.cwd(), ".github/workflows/release-artifact.yml"), "utf8");

    expect(unit).toContain("Environment=BRIDGE_PROVIDER_LOCK=grok");
    expect(unit).toContain("EnvironmentFile=/etc/default/agent-bridge-grok");
    expect(releaseWorkflow).toContain("systemd/agent-bridge-grok.service");
  });
});
