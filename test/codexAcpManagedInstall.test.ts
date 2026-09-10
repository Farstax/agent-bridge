import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveCodexAcpCommand } from "../src/providers/codexAcpConfig.js";
import { getLockedAcpRegistryEntry } from "../src/providers/acpRegistry.js";

const installer = resolve(process.cwd(), "scripts/agent-bridge-install.py");
const installSh = resolve(process.cwd(), "scripts/install.sh");

function probe(body: string): unknown {
  const source = `
import importlib.util, json, pathlib, sys
path = pathlib.Path(${JSON.stringify(installer)})
spec = importlib.util.spec_from_file_location("agent_bridge_install_acp_test", path)
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
${body}
`;
  return JSON.parse(execFileSync("python3", ["-c", source], { encoding: "utf8" }));
}

describe("managed ACP installation", () => {
  it("propagates ACP adapter configuration through the existing interactive service", () => {
    const result = probe(`
env = {
  "TELEGRAM_BOT_TOKEN_INTERACTIVE": "interactive-token",
  "INTERACTIVE_CLI_CHAIN": "codex",
  "CODEX_ACP_COMMAND": "/opt/agent-bridge/releases/current/node_modules/.bin/codex-acp",
  "CODEX_ACP_ARGS": "--verbose",
}
services = module.selected_services(env)
interactive = services[0]
values = module.service_values(
  env,
  pathlib.Path("/etc/default/agent-bridge-interactive"),
  pathlib.Path("/var/lib/agent-bridge/interactive/bridge.sqlite"),
  interactive[2],
)
print(json.dumps({"values": values}))
`) as { values: Record<string, string> };

    expect(result.values).toMatchObject({
      TELEGRAM_BOT_TOKEN_INTERACTIVE: "interactive-token",
      INTERACTIVE_CLI_CHAIN: "codex",
      CODEX_ACP_COMMAND: "/opt/agent-bridge/releases/current/node_modules/.bin/codex-acp",
      CODEX_ACP_ARGS: "--verbose",
    });
  });

  it("allowlists ACP adapter keys on the shared service environment as well", () => {
    const keys = probe(`
print(json.dumps({
  "shared": [key for key in module.SHARED_KEYS],
  "service": [key for key in module.SERVICE_KEYS],
}))
`) as { shared: string[]; service: string[] };
    for (const key of ["CODEX_ACP_COMMAND", "CODEX_ACP_ARGS"]) {
      expect(keys.shared).toContain(key);
      expect(keys.service).toContain(key);
    }
  });

  it("carries ACP adapter keys through source install env seeding and shared defaults", () => {
    const script = readFileSync(installSh, "utf8");
    expect(script).not.toContain("AGENT_BRIDGE_CODEX_RUNTIME");
    expect(script).toContain("CODEX_ACP_COMMAND");
    expect(script).toContain("CODEX_ACP_ARGS");
  });

  it("pins every qualified npx ACP adapter as a production dependency", () => {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const expected = [
      { provider: "codex" as const, packageName: "@agentclientprotocol/codex-acp", bin: "codex-acp" },
      { provider: "claude" as const, packageName: "@agentclientprotocol/claude-agent-acp", bin: "claude-agent-acp" },
    ];

    for (const { provider, packageName, bin } of expected) {
      const locked = getLockedAcpRegistryEntry(provider);
      expect(locked?.distribution.npx?.package).toBe(`${packageName}@${locked?.version}`);
      expect(pkg.dependencies?.[packageName]).toBe(locked?.version);
      expect(existsSync(resolve(process.cwd(), `node_modules/.bin/${bin}`))).toBe(true);
    }
  });

  it("resolves the same bundled Codex adapter the production runtime launches", () => {
    const root = "/opt/agent-bridge/releases/current";
    expect(resolveCodexAcpCommand({ BRIDGE_CURRENT_RELEASE_DIR: root })).toBe(
      `${root}/node_modules/.bin/codex-acp`,
    );
    expect(resolveCodexAcpCommand({
      BRIDGE_CURRENT_RELEASE_DIR: root,
      CODEX_ACP_COMMAND: "/custom/codex-acp",
    })).toBe("/custom/codex-acp");
  });
});
