#!/usr/bin/env python3
from pathlib import Path
import subprocess

BRANCH = "agent/issue-458-advisor-skill"


def run(*args: str) -> None:
    subprocess.run(args, check=True)


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    if text.count(old) != 1:
        raise RuntimeError(f"expected one repair target in {path}, found {text.count(old)}")
    p.write_text(text.replace(old, new, 1))


if '"version": "1.0.0"' in Path("skills/advisor/skill.json").read_text():
    print("issue 458 repair already applied")
    raise SystemExit(0)

p = Path("test/commands.test.ts")
text = p.read_text()
imports = (
    'import { mkdtempSync, rmSync, writeFileSync } from "node:fs";\n'
    'import { tmpdir } from "node:os";\n'
    'import { join } from "node:path";\n'
)
if imports not in text:
    raise RuntimeError("stale advisor command imports not found")
text = text.replace(imports, "", 1)
marker = "\nconst advisorEnvKeys = ["
if marker not in text:
    raise RuntimeError("stale advisor status suite not found")
p.write_text(text[: text.index(marker)].rstrip() + "\n")

p = Path("test/engine.test.ts")
text = p.read_text()
start = '    it("tells the agent how to call the advisor when it is enabled", async () => {'
end = '  });\n\n  describe("/reset command"'
if start not in text or end not in text:
    raise RuntimeError("stale advisor prompt-affordance test not found")
a = text.index(start)
b = text.index(end, a)
p.write_text(text[:a] + text[b:])

replace_once(
    "test/initialInstall.test.ts",
    '      "health-troubleshooting",\n    ];',
    '      "health-troubleshooting",\n      "advisor",\n    ];',
)
replace_once(
    "test/advisorBroker.test.ts",
    '  runCli = vi.fn().mockResolvedValue(JSON.stringify({ result: "Independent view" })),\n',
    '  runCli = vi.fn().mockImplementation(async (command: string) => command.includes("codex")\n'
    '    ? JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Independent view" } })\n'
    '    : JSON.stringify({ result: "Independent view" })),\n',
)

run("git", "config", "user.name", "github-actions[bot]")
run("git", "config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com")
run("git", "add", "test/commands.test.ts", "test/engine.test.ts", "test/initialInstall.test.ts", "test/advisorBroker.test.ts")
run("git", "commit", "-m", "test: align advisor subtraction regressions")

replace_once(
    "skills/advisor/skill.json",
    '  "version": 1\n',
    '  "version": "1.0.0"\n',
)

p = Path("src/advisorBroker.ts")
text = p.read_text()
start = "  private accept(socket: Socket): void {"
end = "\n  private async handleWireRequest("
if start not in text or end not in text:
    raise RuntimeError("advisor broker accept function not found")
a = text.index(start)
b = text.index(end, a)
replacement = '''  private accept(socket: Socket): void {
    let input = "";
    let started = false;
    let settled = false;
    let executionId: string | null = null;
    const cancel = () => {
      if (!settled && executionId) void this.abortCli(executionId);
    };
    socket.once("close", cancel);
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      if (started) return;
      input += chunk;
      const newline = input.indexOf("\\n");
      if (newline === -1) return;
      started = true;
      const raw = input.slice(0, newline);
      void this.handleWireRequest(raw, (id) => { executionId = id; }).then((response) => {
        settled = true;
        socket.off("close", cancel);
        if (!socket.destroyed) socket.end(`${JSON.stringify(response)}\\n`);
      });
    });
    socket.on("end", () => {
      if (started) {
        if (!settled && executionId) void this.abortCli(executionId);
        settled = true;
        socket.off("close", cancel);
        if (!socket.destroyed) socket.destroy();
        return;
      }
      if (socket.destroyed) return;
      settled = true;
      socket.off("close", cancel);
      socket.end(`${JSON.stringify({ ok: false, error: "Invalid advisor broker request" })}\\n`);
    });
  }
'''
text = text[:a] + replacement + text[b:]
old = "    socket.end(JSON.stringify(input));\n"
if text.count(old) != 1:
    raise RuntimeError("advisor broker client request write not found")
p.write_text(text.replace(old, '    socket.write(`${JSON.stringify(input)}\\n`);\n', 1))

run("git", "add", "skills/advisor/skill.json", "src/advisorBroker.ts")
run("git", "commit", "-m", "fix: repair bounded advisor capability path")

run(
    "npx", "vitest", "run",
    "test/advisorBroker.test.ts",
    "test/advisorRouting.test.ts",
    "test/skills.test.ts",
    "test/systematicDebuggingSkill.test.ts",
    "test/deliveryDirectivesSkill.test.ts",
    "test/initialInstall.test.ts",
    "test/commands.test.ts",
    "test/engine.test.ts",
)
run("npm", "run", "typecheck")
run("git", "push", "origin", f"HEAD:{BRANCH}")
