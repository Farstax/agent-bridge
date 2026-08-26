import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { qualifyProvider } from "../src/providers/qualification.js";

function executable(path: string, body: string): string {
  writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}`, { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

describe("Agy provider qualification stream-json contract", () => {
  it("qualifies fresh and resumed prompts through stream-json terminal results", async () => {
    const root = mkdtempSync(join(tmpdir(), "provider-qualification-agy-stream-"));
    const evidencePath = join(root, "qualification.json");
    const conversationId = "22222222-3333-4444-5555-666666666666";
    const fake = executable(join(root, "agy"), `
if [[ "\${1:-}" == "--version" ]]; then
  echo "agy 1.1.12"
  exit 0
fi
if [[ " $* " != *" --output-format stream-json "* ]]; then
  echo "expected stream-json qualification mode" >&2
  exit 2
fi
marker="AGENT_BRIDGE_QUALIFICATION_OK"
if [[ " $* " == *" --conversation ${conversationId} "* ]]; then
  marker="AGENT_BRIDGE_QUALIFICATION_RESUME_OK"
fi
printf '%s\\n' '{"event":"init","conversation_id":"${conversationId}","init":{"cwd":"/tmp"}}'
printf '%s\\n' '{"event":"step_update","step_update":{"step_index":1,"state":"DONE","step_type":"system_message"}}'
printf '%s\\n' '{"event":"result","result":{"conversation_id":"${conversationId}","status":"SUCCESS","response":"'"$marker"'"}}'
`);

    const result = await qualifyProvider({
      providerId: "agy",
      executable: fake,
      evidencePath,
      bridgeCommit: "d".repeat(40),
      cwd: root,
      homeDir: root,
      timeoutMs: 5_000,
    });

    expect(result.overall).toBe("pass");
    expect(result.checks.map((check) => [check.name, check.status])).toEqual([
      ["version", "pass"],
      ["fresh_prompt", "pass"],
      ["session_resume", "pass"],
    ]);
  });
});
