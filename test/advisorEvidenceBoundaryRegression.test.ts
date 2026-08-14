import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdvisorEvidenceToolBroker } from "../src/advisorEvidenceTools.js";
import { AdvisorService } from "../src/advisorService.js";
import type { AdvisorConfig } from "../src/advisorTypes.js";
import { openDb } from "../src/db.js";

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function config(): AdvisorConfig {
  return {
    enabled: true,
    mode: "manual",
    chain: [{ provider: "claude", model: "claude-fable-5" }],
    maxCallsPerTurn: 2,
    maxCallsPerTask: 2,
    timeoutMs: 5_000,
    contextMaxChars: 20_000,
  };
}

describe("advisor evidence boundary regressions", () => {
  it("scrubs task and supplied worker context before the first advisor turn", async () => {
    const dir = tempDir("advisor-context-redaction-");
    const db = openDb(join(dir, "bridge.sqlite"));
    const runCli = vi.fn().mockImplementation(async (_command: string, args: string[]) => {
      const prompt = String(args.at(-1));
      if (prompt.includes('"tool_requests"')) {
        return JSON.stringify({
          hypothesis: "The supplied context is sufficient.",
          tool_requests: [],
          missing_evidence: [],
        });
      }
      return JSON.stringify({
        advice_md: "Use the existing boundary.",
        risks: [],
        suggested_next_steps: [],
        confidence: "low",
      });
    });
    const service = new AdvisorService({
      db,
      config: config(),
      bots: { claude: { command: "claude", modelPreference: null } },
      runCli,
    });
    const jwt = "eyJabcdefghijk.eyJabcdefghijkl.mnopqrstuvwxyz";

    try {
      await service.requestTrusted({
        origin: "manual",
        scopeKey: "manual:redaction",
        taskKey: "redaction",
        mode: "review",
        task: "Review client_secret=task-secret",
        activeProvider: "codex",
        activeModel: null,
        cwd: dir,
        evidence: {
          acceptanceCriteria: "Authorization: Bearer acceptance-secret",
          plan: "DATABASE_URL=postgres://user:pass@db.example/app",
          testOutput: `session=${jwt}`,
          references: ["AWS_SECRET_ACCESS_KEY=aws-secret"],
        },
      });

      const invocation = JSON.stringify(runCli.mock.calls[0]);
      for (const secret of ["task-secret", "acceptance-secret", "user:pass", jwt, "aws-secret"]) {
        expect(invocation).not.toContain(secret);
      }
      expect(invocation).toContain("REDACTED");
    } finally {
      db.close();
    }
  });

  it("marks search evidence incomplete when an enumerated file cannot be inspected", async () => {
    const dir = tempDir("advisor-search-incomplete-");
    writeFileSync(join(dir, "readable.txt"), "ordinary text\n");
    writeFileSync(join(dir, "binary.bin"), Buffer.from([0, 1, 2, 3]));
    const broker = new AdvisorEvidenceToolBroker({ repoPath: dir });

    const [result] = await broker.execute([
      { tool: "repo.search_text", path: ".", query: "not-present" },
    ]);

    expect(result).toMatchObject({ status: "exhausted", truncated: true });
    expect(result.content).toBe("No literal matches found in the scanned subset.");
    expect(result.summary).toMatch(/could not be inspected/i);
  });

  it("omits sensitive Git paths, degrades completeness, and keeps audit arguments hashed", async () => {
    const dir = tempDir("advisor-git-sensitive-");
    const audit = vi.fn();
    const runGit = vi.fn().mockResolvedValue([
      "## main",
      "?? .env.shared",
      " M src/app.ts",
      "diff --git a/.env.shared b/.env.shared",
      "--- a/.env.shared",
      "+++ b/.env.shared",
      "+TOKEN=top-secret",
      "diff --git a/src/app.ts b/src/app.ts",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "+export const ready = true;",
    ].join("\n"));
    const broker = new AdvisorEvidenceToolBroker({ repoPath: dir, runGit, audit });

    const [result] = await broker.execute([{ tool: "git.diff", scope: "working" }]);

    expect(result).toMatchObject({ status: "exhausted", truncated: true, source: "git.diff scope=working" });
    expect(result.content).toContain("src/app.ts");
    expect(result.content).not.toContain(".env.shared");
    expect(result.content).not.toContain("top-secret");
    expect(result.summary).toMatch(/sensitive Git paths were omitted/i);
    expect(JSON.stringify(audit.mock.calls)).not.toContain(".env.shared");
    expect(JSON.stringify(audit.mock.calls)).not.toContain("src/app.ts");
  });

  it("retains bounded source attribution while hashing repository paths in audit metadata", async () => {
    const dir = tempDir("advisor-source-attribution-");
    writeFileSync(join(dir, "service.ts"), "export const ready = true;\n");
    const audit = vi.fn();
    const broker = new AdvisorEvidenceToolBroker({ repoPath: dir, audit });

    const [result] = await broker.execute([{ tool: "repo.read_file", path: "service.ts" }]);

    expect(result.source).toBe("repo.read_file path=service.ts");
    const auditJson = JSON.stringify(audit.mock.calls);
    expect(auditJson).not.toContain("service.ts");
    expect(auditJson).toMatch(/pathSha256/);
  });
});
