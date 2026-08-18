#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def read(path: str) -> str:
    return (ROOT / path).read_text()

def write(path: str, text: str) -> None:
    (ROOT / path).write_text(text)

def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected 1 occurrence, found {count}")
    return text.replace(old, new, 1)

# The existing exact-release regression owns the default skill inventory.
path = "test/initialInstall.test.ts"
s = read(path)
s = replace_once(s,
'''      "git-sandbox",\n      "cli-auth-telegram",\n    ];''',
'''      "git-sandbox",\n      "cli-auth-telegram",\n      "autonomous-work",\n    ];''', "initial installer expected skill inventory")
write(path, s)

# Keep the new skill contract test on public filesystem/catalogue behavior rather
# than depending on a private helper export.
write("test/autonomousWorkSkill.test.ts", r'''import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("autonomous-work skill convergence (#466)", () => {
  it("is provider-neutral and teaches the approved Goal/Episode/Cycle/Run contract", () => {
    const root = process.cwd();
    const manifest = JSON.parse(readFileSync(join(root, "skills", "autonomous-work", "skill.json"), "utf8"));
    expect(manifest.name).toBe("autonomous-work");
    const text = readFileSync(join(root, "skills", "autonomous-work", "SKILL.md"), "utf8");
    for (const term of ["Goal", "Episode", "Cycle", "Run", "current truth", "supervisorMessage", "frozen authority"]) expect(text).toContain(term);
    expect(text).not.toContain("Farstax");
    expect(text).not.toContain("Company runtime");
  });

  it("converges the required skill on fresh install and --update even with a custom list", () => {
    const install = readFileSync(join(process.cwd(), "scripts", "install.sh"), "utf8");
    const upgrade = readFileSync(join(process.cwd(), "scripts", "upgrade.sh"), "utf8");
    expect(install).toContain("autonomous-work");
    expect(upgrade).toContain("autonomous-work");
    expect(upgrade).toContain("[update] Converging shared skills");
    expect(install).toContain('skills_csv="${skills_csv},autonomous-work"');
    expect(upgrade).toContain('skills_csv="${skills_csv},autonomous-work"');
  });
});
''')

# /autonomy commands are control-plane commands even when sent as replies to a
# supervisor message. They must fall through correlation so /autonomy stop stays
# an immediate intervention rather than becoming next-cycle supervisor input.
path = "src/autonomyTelegram.ts"
s = read(path)
s = replace_once(s,
'''  const text = (message.text ?? message.caption ?? "").trim();
  if (!replyId || senderId == null || !text) return null;''',
'''  const text = (message.text ?? message.caption ?? "").trim();
  if (!replyId || senderId == null || !text) return null;
  if (/^\\/autonomy(?:@[A-Za-z0-9_]+)?(?:\\s|$)/i.test(text)) return null;''',
"autonomy command reply precedence")
s = replace_once(s,
'''  const threadId = message.message_thread_id === undefined ? undefined : String(message.message_thread_id);
  if (state.route.thread !== undefined && state.route.thread !== threadId) return null;''',
'''  const threadId = message.message_thread_id === undefined ? undefined : String(message.message_thread_id);
  if (state.route.thread !== threadId) return null;''',
"exact autonomy supervisor thread correlation")
write(path, s)

path = "test/autonomyFirstClass.test.ts"
s = read(path)
s = replace_once(s,
'''    expect(matchAutonomousTelegramSupervisorReply(db, message)).toMatchObject({ goalId: "reply", text: "use option B" });
    expect(matchAutonomousTelegramSupervisorReply(db, { ...message, from: { id: 43 } })).toBeNull();
    expect(matchAutonomousTelegramSupervisorReply(db, { ...message, reply_to_message: { message_id: 899 } })).toBeNull();
    db.raw.prepare("UPDATE autonomous_goals SET status = 'complete' WHERE goal_id = 'reply'").run();''',
'''    expect(matchAutonomousTelegramSupervisorReply(db, message)).toMatchObject({ goalId: "reply", text: "use option B" });
    expect(matchAutonomousTelegramSupervisorReply(db, { ...message, text: "/autonomy stop" })).toBeNull();
    expect(matchAutonomousTelegramSupervisorReply(db, { ...message, from: { id: 43 } })).toBeNull();
    expect(matchAutonomousTelegramSupervisorReply(db, { ...message, reply_to_message: { message_id: 899 } })).toBeNull();
    db.setSetting("autonomy:supervisor:reply", JSON.stringify({
      route: { surface: "telegram", address: "123", identity: "42" }, messageIds: [900],
    }));
    expect(matchAutonomousTelegramSupervisorReply(db, message)).toBeNull();
    db.raw.prepare("UPDATE autonomous_goals SET status = 'complete' WHERE goal_id = 'reply'").run();''',
"autonomy reply correlation regressions")
write(path, s)

print("issue #466 repair 2 applied")
