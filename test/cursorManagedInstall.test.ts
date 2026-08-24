import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const installer = resolve(process.cwd(), "scripts/agent-bridge-install.py");

function probe(body: string): unknown {
  const source = `
import importlib.util, json, pathlib, sys
path = pathlib.Path(${JSON.stringify(installer)})
spec = importlib.util.spec_from_file_location("agent_bridge_install_cursor_test", path)
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
${body}
`;
  return JSON.parse(execFileSync("python3", ["-c", source], { encoding: "utf8" }));
}

describe("managed Cursor provider installation", () => {
  it("propagates Cursor runtime configuration through the existing interactive service", () => {
    const result = probe(`
env = {
  "TELEGRAM_BOT_TOKEN_INTERACTIVE": "interactive-token",
  "INTERACTIVE_CLI_CHAIN": "cursor",
  "CURSOR_COMMAND": "/home/agentbridge/.local/bin/cursor-agent",
  "CURSOR_MODEL_PREFERENCE": "composer-2.5,auto",
  "CURSOR_EFFORT": "high",
  "CURSOR_PROJECT_DIR": "/srv/workspace",
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

    expect(result.values).toMatchObject({
      TELEGRAM_BOT_TOKEN_INTERACTIVE: "interactive-token",
      INTERACTIVE_CLI_CHAIN: "cursor",
      CURSOR_COMMAND: "/home/agentbridge/.local/bin/cursor-agent",
      CURSOR_MODEL_PREFERENCE: "composer-2.5,auto",
      CURSOR_EFFORT: "high",
      CURSOR_PROJECT_DIR: "/srv/workspace",
    });
  });
});
