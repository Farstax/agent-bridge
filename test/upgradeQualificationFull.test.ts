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

function fakeProvider(path: string, versionBody: string, invocationLog: string): void {
  script(path, `
printf '%s\\n' "$0 $*" >> "${invocationLog}"
${versionBody}
response="native protocol response"
if [ -f src/repositoryGroundingFixture.ts ] && [ -f AGENTS.md ]; then
  fact="$(grep -o 'AGENT_BRIDGE_GROUNDING_FACT_[A-Za-z0-9]*' src/repositoryGroundingFixture.ts | head -n1)"
  marker="$(grep -o 'AGENT_BRIDGE_GROUNDING_INSTRUCTION_[A-Za-z0-9]*' AGENTS.md | head -n1)"
  response="$fact $marker"
fi
session="11111111-2222-3333-4444-555555555555"
case "$(basename "$0")" in
  codex)
    printf '%s\\n' "{\\"type\\":\\"thread.started\\",\\"thread_id\\":\\"$session\\"}"
    printf '%s\\n' "{\\"type\\":\\"item.completed\\",\\"item\\":{\\"type\\":\\"agent_message\\",\\"text\\":\\"$response\\"}}"
    ;;
  claude)
    printf '%s\\n' "{\\"result\\":\\"$response\\",\\"session_id\\":\\"$session\\"}"
    ;;
  agy)
    printf '%s\\n' "{\\"event\\":\\"result\\",\\"result\\":{\\"conversation_id\\":\\"$session\\",\\"status\\":\\"SUCCESS\\",\\"response\\":\\"$response\\"}}"
    ;;
  grok)
    printf '%s\\n' "{\\"type\\":\\"text\\",\\"data\\":\\"$response\\"}"
    printf '%s\\n' "{\\"type\\":\\"end\\",\\"sessionId\\":\\"$session\\",\\"stopReason\\":\\"end_turn\\"}"
    ;;
  cursor-agent|cursor)
    printf '%s\\n' "{\\"type\\":\\"result\\",\\"subtype\\":\\"success\\",\\"is_error\\":false,\\"result\\":\\"$response\\",\\"session_id\\":\\"$session\\"}"
    ;;
  *)
    echo "unsupported fake provider" >&2
    exit 99
    ;;
esac
`);
}

describe("full CLI update qualification", () => {
  it("uses only fixture provider CLIs and fixture qualification state", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-full-update-qualification-"));
    const hostRoot = mkdtempSync(join(tmpdir(), "agent-bridge-host-provider-trap-"));
    const agyState = join(root, "agy-updated");
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

      fakeProvider(claude, `
if [ "$1" = --version ]; then
  if [ -f "${claudeState}" ]; then echo 'Claude Code 1.1.0'; else echo 'Claude Code 1.0.0'; fi
  exit 0
fi
if [ "$1" = update ]; then touch "${claudeState}"; exit 0; fi
`, qualificationLog);
      fakeProvider(codex, `
if [ "$1" = --version ]; then echo 'codex-cli 1.1.0'; exit 0; fi
`, qualificationLog);
      fakeProvider(agy, `
if [ "$1" = --version ]; then
  if [ -f "${agyState}" ]; then echo 'agy 1.1.13'; else echo 'agy 1.1.12'; fi
  exit 0
fi
`, qualificationLog);
      fakeProvider(grok, `
if [ "$1" = --version ]; then echo 'grok 1.2.3'; exit 0; fi
`, qualificationLog);
      fakeProvider(cursor, `
if [ "$1" = --version ]; then echo 'cursor-agent 1.2.3'; exit 0; fi
`, qualificationLog);

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
      script(join(root, "curl"), `
printf '%s\\n' '#!/usr/bin/env bash' 'touch "${agyState}"'
`);
      script(join(root, "systemctl"), "exit 1\n");

      const result = spawnSync("bash", ["scripts/upgrade.sh", "--update"], {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: root,
          NODE_BIN: process.execPath,
          CLAUDE_COMMAND: claude,
          CODEX_COMMAND: codex,
          ANTIGRAVITY_COMMAND: agy,
          GROK_COMMAND: grok,
          CURSOR_COMMAND: cursor,
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

      const invocations = readFileSync(qualificationLog, "utf8");
      expect(invocations).toContain(claude);
      expect(invocations).toContain(codex);
      expect(invocations).toContain(agy);
      expect(invocations).not.toContain(hostRoot);

      const evidence = JSON.parse(readFileSync(qualificationEvidence, "utf8")) as {
        providers?: Record<string, { overall?: string; providerVersion?: string }>;
      };
      expect(evidence.providers).toMatchObject({
        claude: { overall: "pass", providerVersion: "1.1.0" },
        codex: { overall: "pass", providerVersion: "1.1.0" },
        agy: { overall: "pass", providerVersion: "1.1.13" },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(hostRoot, { recursive: true, force: true });
    }

    expect(existsSync(root)).toBe(false);
    expect(existsSync(hostRoot)).toBe(false);
  });
});
