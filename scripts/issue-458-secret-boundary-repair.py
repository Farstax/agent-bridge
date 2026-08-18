#!/usr/bin/env python3
from pathlib import Path
import subprocess
import sys

BRANCH = "agent/issue-458-advisor-skill"


def run(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, check=check, text=True)


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"expected one target in {path}, found {count}")
    p.write_text(text.replace(old, new, 1))


# Idempotent if the repair has already landed.
if "redactAdvisorSecretText" in Path("src/advisor.ts").read_text():
    print("issue 458 secret-boundary repair already applied")
    raise SystemExit(0)

run("git", "config", "user.name", "github-actions[bot]")
run("git", "config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com")

# RED: prove the surviving primitive must scrub secret-shaped payloads before
# the second provider receives the prompt.
p = Path("test/advisorBroker.test.ts")
text = p.read_text()
marker = '''  it("bounds caller context, output and per-turn invocation budget", async () => {
'''
if marker not in text:
    raise RuntimeError("advisor broker insertion marker not found")
red_test = '''  it("redacts secret-shaped question and context before invoking the second provider", async () => {
    const { broker, db, runCli } = setup();
    const capability = broker.issue({
      chatKey: "chat:secret-boundary",
      cliKind: "codex",
      turnKey: "turn:secret-boundary",
      taskKey: "task:secret-boundary",
      repoPath: "/repo",
    });
    const githubToken = `ghp_${"A".repeat(24)}`;

    await broker.requestWithCapability({
      capability,
      question: `Review token=question-secret ${githubToken}`,
      context: "password=context-secret\\n-----BEGIN PRIVATE KEY-----\\nprivate-material\\n-----END PRIVATE KEY-----",
    });

    expect(runCli).toHaveBeenCalledTimes(1);
    const providerArgs = JSON.stringify(runCli.mock.calls[0][1]);
    expect(providerArgs).not.toContain("question-secret");
    expect(providerArgs).not.toContain("context-secret");
    expect(providerArgs).not.toContain(githubToken);
    expect(providerArgs).not.toContain("private-material");
    expect(providerArgs).toContain("[REDACTED");
    db.close();
  });

'''
p.write_text(text.replace(marker, red_test + marker, 1))
run("git", "add", "test/advisorBroker.test.ts")
run("git", "commit", "-m", "test: preserve advisor secret boundary")

red = run("npx", "vitest", "run", "test/advisorBroker.test.ts", check=False)
if red.returncode == 0:
    print("ERROR: secret-boundary regression unexpectedly passed before implementation", file=sys.stderr)
    raise SystemExit(1)
print("EXPECTED RED: advisor secret-boundary regression failed before implementation")

# GREEN: retain only the mechanical secret scrubber needed at the surviving
# cross-provider boundary. Do not restore evidence gathering or Advisor policy.
p = Path("src/advisor.ts")
text = p.read_text()
anchor = '''const normalizeProvider = (provider: string): string => provider === "antigravity" ? "agy" : provider;

'''
if anchor not in text:
    raise RuntimeError("advisor redaction insertion marker not found")
helper = r'''const ADVISOR_SECRET_KEYS = [
  "access[_-]?key", "api[_-]?key", "auth[_-]?token", "bearer[_-]?token",
  "client[_-]?secret", "connection[_-]?string", "credential", "database[_-]?url",
  "db[_-]?url", "github[_-]?token", "gh[_-]?token", "oauth[_-]?token", "password",
  "private[_-]?key", "refresh[_-]?token", "secret", "secret[_-]?access[_-]?key",
  "secret[_-]?key", "session[_-]?token", "token",
].join("|");
const ADVISOR_SECRET_ASSIGNMENT_RE = new RegExp(
  `(["']?(?:${ADVISOR_SECRET_KEYS})["']?\\s*[:=]\\s*)(?:"[^"\\r\\n]*"|'[^'\\r\\n]*'|[^\\s,;]+)`,
  "gi",
);

/** Mechanical cross-provider boundary: scrub common credential shapes before payload leaves Bridge ownership. */
function redactAdvisorSecretText(text: string): string {
  return text
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, "[REDACTED PRIVATE KEY]")
    .replace(ADVISOR_SECRET_ASSIGNMENT_RE, "$1[REDACTED]")
    .replace(/\b((?:proxy-)?authorization\s*:\s*)(?:bearer|basic)\s+[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^\/\s:@]+):([^@\s\/]+)@/gi, "$1[REDACTED]@")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED JWT]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED AWS ACCESS KEY]")
    .replace(/\b(?:gh[opsu]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[REDACTED GITHUB TOKEN]")
    .replace(/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,}|sk_(?:live|test)_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/g, "[REDACTED TOKEN]");
}

'''
text = text.replace(anchor, anchor + helper, 1)
old = '''  const question = boundedText(request.question, "question", Math.min(config.contextMaxChars, 4_000), true);
  const context = boundedText(request.context ?? "", "context", config.contextMaxChars, false);
'''
new = '''  const question = redactAdvisorSecretText(boundedText(request.question, "question", Math.min(config.contextMaxChars, 4_000), true));
  const context = redactAdvisorSecretText(boundedText(request.context ?? "", "context", config.contextMaxChars, false));
'''
if text.count(old) != 1:
    raise RuntimeError("advisor payload boundary target not found")
p.write_text(text.replace(old, new, 1))

run("git", "add", "src/advisor.ts")
run("git", "commit", "-m", "fix: redact bounded advisor payload")
run("npx", "vitest", "run", "test/advisorBroker.test.ts", "test/advisorRouting.test.ts")
run("npm", "run", "typecheck")
run("git", "push", "origin", f"HEAD:{BRANCH}")
