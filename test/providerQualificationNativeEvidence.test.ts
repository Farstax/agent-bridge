import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { qualifyProvider } from "../src/providers/qualification.js";
import type { ProviderId } from "../src/providers/types.js";

function executable(path: string, body: string): string {
  writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}`, { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

async function qualify(providerId: ProviderId, body: string) {
  const root = mkdtempSync(join(tmpdir(), `provider-native-${providerId}-`));
  const fake = executable(join(root, providerId), body);
  return qualifyProvider({
    providerId,
    executable: fake,
    evidencePath: join(root, "qualification.json"),
    bridgeCommit: "4".repeat(40),
    cwd: root,
    homeDir: root,
    timeoutMs: 5_000,
  });
}

const SESSION = "11111111-2222-3333-4444-555555555555";
const OTHER_SESSION = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

describe("native provider qualification evidence", () => {
  it("qualifies Codex from native result/session evidence without semantic marker prose", async () => {
    const result = await qualify("codex", `
if [[ "\${1:-}" == "--version" ]]; then echo "codex-cli 9.9.9"; exit 0; fi
printf '%s\\n' '{"type":"thread.started","thread_id":"${SESSION}"}'
printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"native protocol response"}}'
`);

    expect(result.overall).toBe("pass");
    expect(result.checks.map((check) => [check.name, check.status])).toEqual([
      ["version", "pass"],
      ["fresh_prompt", "pass"],
      ["session_resume", "pass"],
    ]);
  });

  it("qualifies Claude from native result/session evidence without semantic marker prose", async () => {
    const result = await qualify("claude", `
if [[ "\${1:-}" == "--version" ]]; then echo "Claude Code 2.3.4"; exit 0; fi
printf '%s\\n' '{"result":"native protocol response","session_id":"${SESSION}"}'
`);

    expect(result.overall).toBe("pass");
    expect(result.checks.find((check) => check.name === "session_resume")?.status).toBe("pass");
  });

  it("qualifies Agy from strict stream-json conversation evidence without semantic marker prose", async () => {
    const result = await qualify("agy", `
if [[ "\${1:-}" == "--version" ]]; then echo "agy 1.1.12"; exit 0; fi
printf '%s\\n' '{"event":"result","result":{"conversation_id":"${SESSION}","status":"SUCCESS","response":"native protocol response"}}'
`);

    expect(result.overall).toBe("pass");
    expect(result.checks.find((check) => check.name === "session_resume")?.status).toBe("pass");
  });

  it("fails resume compatibility when the provider returns a different native session identity", async () => {
    const result = await qualify("codex", `
if [[ "\${1:-}" == "--version" ]]; then echo "codex-cli 9.9.9"; exit 0; fi
if [[ " $* " == *" exec resume "* ]]; then
  printf '%s\\n' '{"type":"thread.started","thread_id":"${OTHER_SESSION}"}'
  printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"AGENT_BRIDGE_QUALIFICATION_RESUME_OK"}}'
else
  printf '%s\\n' '{"type":"thread.started","thread_id":"${SESSION}"}'
  printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"AGENT_BRIDGE_QUALIFICATION_OK"}}'
fi
`);

    expect(result.overall).toBe("fail");
    expect(result.checks.find((check) => check.name === "session_resume")).toMatchObject({
      status: "fail",
      diagnostic: expect.stringMatching(/resume compatibility.*session identity/i),
    });
  });

  it("fails closed when a required native session identity is missing", async () => {
    const result = await qualify("claude", `
if [[ "\${1:-}" == "--version" ]]; then echo "Claude Code 2.3.4"; exit 0; fi
printf '%s\\n' '{"result":"native protocol response"}'
`);

    expect(result.overall).toBe("fail");
    expect(result.checks.find((check) => check.name === "fresh_prompt")).toMatchObject({
      status: "fail",
      diagnostic: expect.stringMatching(/session identity/i),
    });
    expect(result.checks.find((check) => check.name === "session_resume")?.status).toBe("not_applicable");
  });

  it("fails closed on malformed provider-native envelopes", async () => {
    const result = await qualify("agy", `
if [[ "\${1:-}" == "--version" ]]; then echo "agy 1.1.12"; exit 0; fi
printf '%s\\n' '{not-json'
`);

    expect(result.overall).toBe("fail");
    expect(result.checks.find((check) => check.name === "fresh_prompt")).toMatchObject({
      status: "fail",
      diagnostic: expect.stringMatching(/native result parsing|stream JSON parse failed/i),
    });
  });
});
