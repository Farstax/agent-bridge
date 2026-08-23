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
  it("propagates Grok runtime configuration through the existing interactive service", () => {
    const result = probe(`
env = {
  "TELEGRAM_BOT_TOKEN_INTERACTIVE": "interactive-token",
  "INTERACTIVE_CLI_CHAIN": "grok",
  "GROK_COMMAND": "/home/agentbridge/.grok/bin/grok",
  "GROK_MODEL_PREFERENCE": "grok-build",
  "GROK_EFFORT": "high",
  "GROK_PROJECT_DIR": "/srv/workspace",
}
services = module.selected_services(env)
interactive = services[0]
values = module.service_values(
  env,
  pathlib.Path("/etc/default/agent-bridge-interactive"),
  pathlib.Path("/var/lib/agent-bridge/interactive/bridge.sqlite"),
  interactive[2],
)
print(json.dumps({"service": list(interactive), "values": values}))
`) as {
      service: [string, string, string[], string];
      values: Record<string, string>;
    };

    expect(result.service).toEqual([
      "agent-bridge-interactive.service",
      "agent-bridge-interactive",
      ["TELEGRAM_BOT_TOKEN_INTERACTIVE"],
      "interactive",
    ]);
    expect(result.values).toMatchObject({
      TELEGRAM_BOT_TOKEN_INTERACTIVE: "interactive-token",
      INTERACTIVE_CLI_CHAIN: "grok",
      GROK_COMMAND: "/home/agentbridge/.grok/bin/grok",
      GROK_MODEL_PREFERENCE: "grok-build",
      GROK_EFFORT: "high",
      GROK_PROJECT_DIR: "/srv/workspace",
    });
  });

  it("does not widen the guarded managed-unit inventory solely for Grok", () => {
    const rollout = readFileSync(resolve(process.cwd(), "scripts/rollout-agent-bridge.sh"), "utf8");
    const releaseWorkflow = readFileSync(resolve(process.cwd(), ".github/workflows/release-artifact.yml"), "utf8");

    expect(rollout).not.toContain("agent-bridge-grok.service");
    expect(releaseWorkflow).not.toContain("agent-bridge-grok.service");
    expect(releaseWorkflow).toContain("systemd/agent-bridge-interactive.service");
  });
});
