import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function script(path: string, content: string): void {
  writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${content}`, { mode: 0o755 });
  chmodSync(path, 0o755);
}

describe("full CLI update qualification", () => {
  it("uses only fixture provider CLIs and fixture qualification state", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-full-update-qualification-"));
    const hostRoot = mkdtempSync(join(tmpdir(), "agent-bridge-host-provider-trap-"));
    const claudeState = join(root, "claude-updated");
    const npmState = join(root, "npm-updated");
    const qualificationLog = join(root, "provider-invocations.log");
    const qualificationEvidence = join(root, "provider-qualification.json");
    const hostInvocationLog = join(hostRoot, "host-provider-invocations.log");
    const hostLogSentinel = "ambient-host-log-must-remain-unchanged\n";
    const claude = join(root, "claude");
    const codex = join(root, "codex");
    const agy = join(root, "agy");
    const grok = join(root, "grok");
    const cursor = join(root, "cursor-agent");

    try {
      writeFileSync(hostInvocationLog, hostLogSentinel);
      for (const provider of ["claude", "codex", "agy", "grok", "cursor-agent"]) {
        script(join(hostRoot, provider), `
printf '%s\\n' "$0 $*" >> "${hostInvocationLog}"
echo "host provider must not be selected: ${provider}" >&2
exit 97
`);
      }

      script(claude, `
printf '%s\n' "$0 $*" >> "${qualificationLog}"
if [ "\${1:-}" = --version ]; then echo '@agentclientprotocol/claude-agent-acp 0.76.0'; exit 0; fi
exec "${process.execPath}" "${join(process.cwd(), "node_modules/tsx/dist/cli.mjs")}" "${join(process.cwd(), "test/support/fakeAcpAgent.ts")}"
`);
      script(codex, `
printf '%s\n' "$0 $*" >> "${qualificationLog}"
if [ "\${1:-}" = --version ]; then echo '@agentclientprotocol/codex-acp 1.10.0'; exit 0; fi
exec "${process.execPath}" "${join(process.cwd(), "node_modules/tsx/dist/cli.mjs")}" "${join(process.cwd(), "test/support/fakeAcpAgent.ts")}"
`);
      script(agy, `
printf '%s\\n' "$0 $*" >> "${qualificationLog}"
if [ "\${1:-}" = --version ]; then echo 'agy_acp_server.par 1.1.1'; exit 0; fi
exec "${process.execPath}" "${join(process.cwd(), "node_modules/tsx/dist/cli.mjs")}" "${join(process.cwd(), "test/support/fakeAcpAgent.ts")}"
`);
      script(grok, `
printf '%s\\n' "$0 $*" >> "${qualificationLog}"
if [ "\${1:-}" = --version ]; then echo 'grok 1.0.30'; exit 0; fi
exec "${process.execPath}" "${join(process.cwd(), "node_modules/tsx/dist/cli.mjs")}" "${join(process.cwd(), "test/support/fakeAcpAgent.ts")}"
`);
      script(cursor, `
printf '%s\\n' "$0 $*" >> "${qualificationLog}"
if [ "\${1:-}" = --version ]; then echo '2026.09.08-6caf4ff'; exit 0; fi
exec "${process.execPath}" "${join(process.cwd(), "node_modules/tsx/dist/cli.mjs")}" "${join(process.cwd(), "test/support/fakeAcpAgent.ts")}"
`);

      script(join(root, "npm"), `
if [ "$1" = list ]; then
  version=1.0.0
  [ ! -f "${npmState}" ] || version=1.1.0
  case "$3" in
    @anthropic-ai/claude-code) echo "@anthropic-ai/claude-code@$version" ;;
    @openai/codex) echo "@openai/codex@$version" ;;
  esac
  exit 0
fi
if [ "$1" = update ] && [ "$2" = -g ]; then touch "${npmState}"; exit 0; fi
if [ "$1" = run ]; then exit 0; fi
if [ "$1" = test ]; then exit 0; fi
if [ "$1" = install ]; then exit 0; fi
exit 0
`);
      script(join(root, "systemctl"), "exit 1\n");
      const sttLog = join(root, "stt-convergence.log");
      script(join(root, "sudo"), `
printf '%s\\n' "$*" >> "${sttLog}"
case "$*" in
  *install-voice-stt.sh*)
    [[ "$*" == *AGENT_BRIDGE_STT_ROOT=/opt/agent-bridge/host-components/voice-stt* ]] || {
      echo "canonical STT root was not forced" >&2
      exit 98
    }
    exit 0
    ;;
esac
echo "unexpected sudo invocation: $*" >&2
exit 97
`);

      const result = spawnSync("bash", ["scripts/upgrade.sh", "--update"], {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: root,
          NODE_BIN: process.execPath,
          CLAUDE_ACP_COMMAND: claude,
          CODEX_ACP_COMMAND: codex,
          FAKE_ACP_STORE: join(root, "codex-acp-sessions.json"),
          FAKE_ACP_RESUME: "1",
          AGY_ACP_COMMAND: agy,
          GROK_ACP_COMMAND: grok,
          GROK_ACP_ARGS: "",
          CURSOR_ACP_COMMAND: cursor,
          CURSOR_ACP_ARGS: "",
          AGENT_BRIDGE_COMMIT: "a".repeat(40),
          AGENT_BRIDGE_PROVIDER_QUALIFICATION_PATH: qualificationEvidence,
          AGENT_BRIDGE_SKILLS: "skip",
          PATH: `${hostRoot}:${root}:${process.env.PATH ?? ""}`,
        },
        timeout: 20_000,
      });

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(readFileSync(hostInvocationLog, "utf8")).toBe(hostLogSentinel);
      expect(existsSync(qualificationEvidence)).toBe(true);
      expect(readFileSync(sttLog, "utf8")).toContain("AGENT_BRIDGE_STT_ROOT=/opt/agent-bridge/host-components/voice-stt");
      expect(readFileSync(sttLog, "utf8")).toContain("install-voice-stt.sh");

      const invocations = readFileSync(qualificationLog, "utf8");
      expect(invocations).toContain(claude);
      expect(invocations).toContain(codex);
      expect(invocations).toContain(agy);
      expect(invocations).not.toContain(hostRoot);

      const evidence = JSON.parse(readFileSync(qualificationEvidence, "utf8")) as {
        providers?: Record<string, { overall?: string; providerVersion?: string }>;
      };
      expect(evidence.providers).toMatchObject({
        claude: { overall: "pass", providerVersion: "0.76.0" },
        codex: { overall: "pass", providerVersion: "1.10.0" },
        agy: { overall: "pass", providerVersion: "1.1.1" },
        cursor: { overall: "pass", providerVersion: "2026.09.08-6caf4ff" },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(hostRoot, { recursive: true, force: true });
    }

    expect(existsSync(root)).toBe(false);
    expect(existsSync(hostRoot)).toBe(false);
  }, 30_000);
});
