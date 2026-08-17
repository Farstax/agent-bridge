#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def read(path: str) -> str:
    return (ROOT / path).read_text()

def write(path: str, text: str) -> None:
    p = ROOT / path
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text)

def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected 1 occurrence, found {count}")
    return text.replace(old, new, 1)

# Preserve the existing bounded prompt contract while clarifying that evidence
# is execution continuity rather than current truth.
path = "src/autonomousGoalRuntime.ts"
s = read(path)
s = replace_once(s, "`Prior execution evidence: ${priorEvidence.length ? priorEvidence.join(\" | \") : \"none\"}`", "`Prior evidence: ${priorEvidence.length ? priorEvidence.join(\" | \") : \"none\"}`", "prior evidence prompt compatibility")
write(path, s)

# /autonomy commands, especially stop, must win over supervisor-reply capture.
path = "src/index-interactive.ts"
s = read(path)
reply_start = s.index("          if (autonomyController && autonomyDb) {")
command_start = s.index("          const autonomyCommand = parseAutonomyTelegramCommand", reply_start)
next_start = s.index("          if (isCliCommandText(rawText, botUsername)) {", command_start)
reply_block = s[reply_start:command_start]
command_block = s[command_start:next_start]
s = s[:reply_start] + command_block + "\n" + reply_block + s[next_start:]
write(path, s)

# Exact-release fresh installer must converge the same provider-neutral skill and
# preserve the generic autonomy runtime settings.
path = "scripts/agent-bridge-install.py"
s = read(path)
s = replace_once(s,
'''    "cli-auth-telegram",\n)''',
'''    "cli-auth-telegram",\n    "autonomous-work",\n)''', "exact-release default autonomous skill")
s = replace_once(s,
'''    "AGENT_BRIDGE_SOUL_PATH", "AGENT_BRIDGE_SOUL_MODE",\n    "BRIDGE_ADVISOR_ENABLED"''',
'''    "AGENT_BRIDGE_SOUL_PATH", "AGENT_BRIDGE_SOUL_MODE",\n    "AGENT_BRIDGE_AUTONOMY_DIR", "AGENT_BRIDGE_AUTONOMY_DB_PATH",\n    "AGENT_BRIDGE_AUTONOMY_MAX_CYCLES",\n    "BRIDGE_ADVISOR_ENABLED"''', "exact-release autonomy env")
s = replace_once(s,
'''    skills = [name.strip() for name in configured.split(",") if name.strip()]\n    if not skills:\n        fail("AGENT_BRIDGE_SKILLS must name at least one skill, none, or skip")''',
'''    skills = [name.strip() for name in configured.split(",") if name.strip()]\n    if not skills:\n        fail("AGENT_BRIDGE_SKILLS must name at least one skill, none, or skip")\n    if "autonomous-work" not in skills:\n        skills.append("autonomous-work")''', "exact-release custom autonomous skill")
write(path, s)

# Regression: immediate /autonomy commands are classified before a reply can be
# consumed as cycle-boundary supervisor input.
write("test/autonomyTelegramRouting.test.ts", r'''import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { parseAutonomyTelegramCommand } from "../src/autonomyTelegram.js";

describe("autonomy Telegram routing precedence (#466)", () => {
  it("keeps /autonomy stop an immediate command even when sent as a reply", () => {
    expect(parseAutonomyTelegramCommand("/autonomy stop")).toBe("stop");
    const source = readFileSync("src/index-interactive.ts", "utf8");
    expect(source.indexOf("const autonomyCommand = parseAutonomyTelegramCommand"))
      .toBeLessThan(source.indexOf("const supervisorReply = matchAutonomousTelegramSupervisorReply"));
  });
});
''')

# Regression: all three deployment paths converge autonomous-work. The exact
# release path both installs and verifies through the shared skill manager,
# which projects to Codex, Claude and Agy using the existing provider registry.
write("test/autonomyExactReleaseInstall.test.ts", r'''import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("autonomous-work exact-release convergence (#466)", () => {
  it("is mandatory for non-opt-out exact-release skill selections", () => {
    const source = readFileSync("scripts/agent-bridge-install.py", "utf8");
    expect(source).toContain('"autonomous-work",');
    expect(source).toContain('if "autonomous-work" not in skills:');
    expect(source).toContain('skills.append("autonomous-work")');
    expect(source).toContain('str(manager),');
    expect(source).toContain('"install", skill, "--force"');
    expect(source).toContain('*command_prefix, "verify", skill');
  });

  it("preserves generic autonomy settings through exact-release installation", () => {
    const source = readFileSync("scripts/agent-bridge-install.py", "utf8");
    for (const key of [
      "AGENT_BRIDGE_AUTONOMY_DIR",
      "AGENT_BRIDGE_AUTONOMY_DB_PATH",
      "AGENT_BRIDGE_AUTONOMY_MAX_CYCLES",
    ]) expect(source).toContain(`"${key}"`);
  });
});
''')

print("issue #466 repair patch applied")
