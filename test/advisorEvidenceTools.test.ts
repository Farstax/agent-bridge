import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AdvisorEvidenceToolBroker,
  parseAdvisorEvidenceToolRequest,
} from "../src/advisorEvidenceTools.js";

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const gitReadPrefix = ["--no-pager", "-c", "core.fsmonitor=false", "-c", "credential.helper="];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("AdvisorEvidenceToolBroker", () => {
  it("collects bounded repository and worker evidence with stable identifiers", async () => {
    const repo = tempDir("advisor-evidence-");
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src", "service.ts"), "export const state = 'blocked';\n");
    const audit = vi.fn();
    const broker = new AdvisorEvidenceToolBroker({
      repoPath: repo,
      evidence: { plan: "Inspect service.ts", acceptance: "State becomes ready" },
      audit,
    });

    const results = await broker.execute([
      { tool: "repo.list_files", path: ".", depth: 2 },
      { tool: "repo.read_file", path: "src/service.ts" },
      { tool: "repo.search_text", path: "src", query: "blocked" },
      { tool: "evidence.plan" },
    ]);

    expect(results.every((result) => result.status === "ok")).toBe(true);
    expect(results.every((result) => result.truncated === false)).toBe(true);
    expect(results[0].content).toContain("src/service.ts");
    expect(results[1].content).toContain("state");
    expect(results[2].content).toContain("src/service.ts:1");
    expect(results[3].content).toBe("Inspect service.ts");
    expect(results.every((result) => /^ev_[a-f0-9]{16}$/.test(result.evidenceId))).toBe(true);
    expect(audit).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(audit.mock.calls)).not.toContain("Inspect service.ts");
  });

  it("uses only isolated fixed Git argument shapes with a real timeout budget", async () => {
    const repo = tempDir("advisor-git-");
    const runGit = vi.fn().mockResolvedValue("git evidence");
    const broker = new AdvisorEvidenceToolBroker({ repoPath: repo, runGit });

    const results = await broker.execute([
      { tool: "git.status" },
      { tool: "git.diff", scope: "staged" },
      { tool: "git.diff", scope: "base_to_head", base: "main", head: "feature/test" },
      { tool: "git.show", object: "HEAD", path: "src/file.ts" },
      { tool: "git.log", count: 4 },
    ]);

    expect(results.every((result) => result.status === "ok")).toBe(true);
    expect(runGit.mock.calls.map(([args, cwd]) => [args, cwd])).toEqual([
      [[...gitReadPrefix, "status", "--short", "--branch", "--untracked-files=normal"], repo],
      [[...gitReadPrefix, "diff", "--cached", "--no-ext-diff", "--no-textconv", "--unified=3"], repo],
      [[...gitReadPrefix, "diff", "--no-ext-diff", "--no-textconv", "--unified=3", "main...feature/test"], repo],
      [[...gitReadPrefix, "show", "--no-ext-diff", "--no-textconv", "HEAD:src/file.ts"], repo],
      [[...gitReadPrefix, "log", "-4", "--date=iso-strict", "--pretty=format:%H%x09%ad%x09%s"], repo],
    ]);
    expect(runGit.mock.calls.every(([, , options]) => options.timeoutMs > 0 && options.timeoutMs <= 5_000)).toBe(true);
  });

  it("fails closed on sensitive files, Git internals, and binary content, but not on traversal or symlinks (Issue #229 Part 2)", async () => {
    const repo = tempDir("advisor-deny-");
    const outside = tempDir("advisor-outside-");
    mkdirSync(join(repo, ".git"));
    writeFileSync(join(repo, ".git", "config"), "[credential]\nhelper=unsafe\n");
    writeFileSync(join(repo, ".env.shared"), "API_KEY=secret\n");
    writeFileSync(join(repo, "binary.bin"), Buffer.from([0, 1, 2]));
    writeFileSync(join(outside, "outside.ts"), "export const escaped = true;\n");
    symlinkSync(join(outside, "outside.ts"), join(repo, "escape.ts"));
    const broker = new AdvisorEvidenceToolBroker({ repoPath: repo });

    const results = await broker.execute([
      // repo and outside are both direct children of the same tmpdir, so
      // this is a genuine "../<sibling>/outside.ts" traversal path.
      { tool: "repo.read_file", path: join("..", basename(outside), "outside.ts") } as never,
      { tool: "repo.read_file", path: ".env.shared" },
      { tool: "repo.read_file", path: ".git/config" },
      { tool: "repo.read_file", path: "escape.ts" },
      { tool: "repo.read_file", path: "binary.bin" },
    ]);

    // The advisor's filesystem scope is "/", not the repo: a real traversal
    // path and a symlink resolving outside the repo both succeed now — only
    // sensitive-named files and binary content remain denied.
    expect(results.map((result) => result.status)).toEqual(["ok", "denied", "denied", "ok", "denied"]);
    expect(results[0].content).toContain("escaped");
    expect(results[3].content).toContain("escaped");
    expect(results[1].content).toBe("");
    expect(results[2].content).toBe("");
    expect(results[4].content).toBe("");
  });

  it("reads an absolute path outside the invoking repo directly (Issue #229 Part 2)", async () => {
    const repo = tempDir("advisor-abs-repo-");
    const outside = tempDir("advisor-abs-outside-");
    writeFileSync(join(outside, "server-log.txt"), "server-wide evidence\n");
    const broker = new AdvisorEvidenceToolBroker({ repoPath: repo });

    const [result] = await broker.execute([
      { tool: "repo.read_file", path: join(outside, "server-log.txt") },
    ]);

    expect(result.status).toBe("ok");
    expect(result.content).toBe("server-wide evidence\n");
  });

  it("scrubs common credentials from ordinary files and Git evidence", async () => {
    const repo = tempDir("advisor-redaction-");
    const jwt = "eyJabcdefghijk.eyJabcdefghijkl.mnopqrstuvwxyz";
    writeFileSync(join(repo, "config.json"), [
      '"client_secret": "client-value"',
      "Authorization: Bearer bearer-value",
      "DATABASE_URL=postgres://user:pass@db.example/app",
      "AWS_ACCESS_KEY_ID=AKIAABCDEFGHIJKLMNOP",
      "AWS_SECRET_ACCESS_KEY=aws-secret-value",
      `session=${jwt}`,
    ].join("\n"));
    const runGit = vi.fn().mockResolvedValue("refresh_token=git-refresh-value\nAuthorization: Basic abc123");
    const broker = new AdvisorEvidenceToolBroker({ repoPath: repo, runGit });

    const results = await broker.execute([
      { tool: "repo.read_file", path: "config.json" },
      { tool: "git.diff", scope: "working" },
    ]);
    const combined = results.map((result) => result.content).join("\n");

    for (const secret of ["client-value", "bearer-value", "user:pass", "AKIAABCDEFGHIJKLMNOP", "aws-secret-value", jwt, "git-refresh-value", "abc123"]) {
      expect(combined).not.toContain(secret);
    }
    expect(combined).toMatch(/REDACTED/);
  });

  it("enforces call and aggregate byte budgets and marks truncation explicitly", async () => {
    const repo = tempDir("advisor-limits-");
    writeFileSync(join(repo, "large.txt"), "x".repeat(200));
    const tooMany = new AdvisorEvidenceToolBroker({
      repoPath: repo,
      limits: { maxCalls: 2, maxResultBytes: 20, maxAggregateBytes: 25 },
    });

    await expect(tooMany.execute([
      { tool: "repo.read_file", path: "large.txt" },
      { tool: "repo.read_file", path: "large.txt" },
      { tool: "repo.read_file", path: "large.txt" },
    ])).rejects.toThrow(/tool limit exceeded/i);

    const broker = new AdvisorEvidenceToolBroker({
      repoPath: repo,
      limits: { maxCalls: 2, maxResultBytes: 20, maxAggregateBytes: 25 },
    });
    const results = await broker.execute([
      { tool: "repo.read_file", path: "large.txt" },
      { tool: "repo.read_file", path: "large.txt" },
    ]);
    expect(results[0].bytes).toBeLessThanOrEqual(20);
    expect(results[0]).toMatchObject({ status: "exhausted", truncated: true });
    expect(results[0].summary).toMatch(/limit/i);
    expect(results[0].bytes + results[1].bytes).toBeLessThanOrEqual(25);
    expect(results[1].truncated).toBe(true);
  });

  it("marks file, entry, match, depth, and per-file scan limits as incomplete", async () => {
    const repo = tempDir("advisor-completeness-");
    mkdirSync(join(repo, "nested"));
    mkdirSync(join(repo, "nested", "deeper"));
    writeFileSync(join(repo, "a.txt"), "alpha\n");
    writeFileSync(join(repo, "b.txt"), "beta\n");
    writeFileSync(join(repo, "nested", "deeper", "late.txt"), `${"x".repeat(50)}needle\n`);
    const broker = new AdvisorEvidenceToolBroker({
      repoPath: repo,
      limits: { maxFiles: 2, maxEntries: 4, maxDepth: 1, maxResultBytes: 20 },
    });

    const [listing, search] = await broker.execute([
      { tool: "repo.list_files", path: ".", depth: 1 },
      { tool: "repo.search_text", path: ".", query: "needle" },
    ]);

    expect(listing).toMatchObject({ status: "exhausted", truncated: true });
    expect(listing.summary).toMatch(/limit/i);
    expect(search).toMatchObject({ status: "exhausted", truncated: true });
    expect(search.content).not.toBe("No literal matches found.");
    expect(search.summary).toMatch(/limit/i);
  });

  it("returns an explicit exhausted result when an evidence operation exceeds its deadline", async () => {
    const repo = tempDir("advisor-timeout-");
    const runGit = vi.fn(() => new Promise<string>(() => undefined));
    const audit = vi.fn();
    const broker = new AdvisorEvidenceToolBroker({
      repoPath: repo,
      runGit,
      audit,
      limits: { timeoutMs: 10 },
    });

    const [result] = await broker.execute([{ tool: "git.status" }]);

    expect(result).toMatchObject({ status: "exhausted", truncated: true, content: "" });
    expect(result.summary).toMatch(/timeout|incomplete/i);
    expect(runGit.mock.calls[0][2].timeoutMs).toBeGreaterThan(0);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ status: "exhausted" }));
  });

  it("validates model-selected tool requests before execution", () => {
    expect(parseAdvisorEvidenceToolRequest({ tool: "git.log", count: 999 })).toEqual({ tool: "git.log", count: 20 });
    // Issue #229 Part 2: traversal is no longer rejected at parse time — the
    // filesystem scope is "/", so a "../" path is only ever denied later, at
    // access time, if the OS can't read it.
    expect(parseAdvisorEvidenceToolRequest({ tool: "repo.read_file", path: "../../etc/passwd" }))
      .toEqual({ tool: "repo.read_file", path: "../../etc/passwd" });
    expect(() => parseAdvisorEvidenceToolRequest({ tool: "repo.read_file", path: ".git/HEAD" })).toThrow(/sensitive/i);
    expect(() => parseAdvisorEvidenceToolRequest({ tool: "git.show", object: "--exec=bad" })).toThrow(/supported Git object/i);
    expect(() => parseAdvisorEvidenceToolRequest({ tool: "git.show", object: "HEAD", path: "src:a.ts" })).toThrow(/not supported/i);
    expect(() => parseAdvisorEvidenceToolRequest({ tool: "shell", command: "cat /etc/passwd" })).toThrow(/unsupported/i);
  });
});
