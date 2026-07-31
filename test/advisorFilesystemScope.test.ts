import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdvisorEvidenceToolBroker, parseAdvisorEvidenceToolRequest } from "../src/advisorEvidenceTools.js";

// Regression coverage for Issue #229 Part 2: the advisor's filesystem scope
// root is "/" — the same read visibility as the invoking CLI process under
// the same Unix account — not a repo or path allowlist. Normal OS read
// permissions are the only boundary. Read-only behaviour, evidence limits,
// redaction, and auditing must be unaffected.

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Issue #229 Part 2: advisor filesystem scope is '/'", () => {
  it("1. reads a file in a sibling repository by absolute path, invoked with a different project as cwd", async () => {
    const invokingCwd = tempDir("advisor-scope-cwd-");
    const siblingRepo = tempDir("advisor-scope-sibling-");
    writeFileSync(join(siblingRepo, "engine.ts"), "export const sibling = true;\n");
    const broker = new AdvisorEvidenceToolBroker({ repoPath: invokingCwd });

    const [result] = await broker.execute([
      { tool: "repo.read_file", path: join(siblingRepo, "engine.ts") },
    ]);

    expect(result.status).toBe("ok");
    expect(result.content).toBe("export const sibling = true;\n");
  });

  it("2. reads a file under a separate temporary server-style root", async () => {
    const invokingCwd = tempDir("advisor-scope-cwd-");
    const serverRoot = tempDir("advisor-scope-server-root-");
    mkdirSync(join(serverRoot, "runtime", "state"), { recursive: true });
    writeFileSync(join(serverRoot, "runtime", "state", "crawler.log"), "2026-07-31 ok\n");
    const broker = new AdvisorEvidenceToolBroker({ repoPath: invokingCwd });

    const [result] = await broker.execute([
      { tool: "repo.read_file", path: join(serverRoot, "runtime", "state", "crawler.log") },
    ]);

    expect(result.status).toBe("ok");
    expect(result.content).toBe("2026-07-31 ok\n");
  });

  it("3. relative paths still resolve against the invoking cwd, not scope root '/'", async () => {
    const invokingCwd = tempDir("advisor-scope-cwd-");
    writeFileSync(join(invokingCwd, "local.ts"), "export const local = true;\n");
    const broker = new AdvisorEvidenceToolBroker({ repoPath: invokingCwd });

    const [result] = await broker.execute([{ tool: "repo.read_file", path: "local.ts" }]);

    expect(result.status).toBe("ok");
    expect(result.content).toBe("export const local = true;\n");
  });

  it("4. git evidence can target an explicit absolute repository path outside the invoking cwd", async () => {
    const invokingCwd = tempDir("advisor-scope-cwd-");
    const otherRepo = tempDir("advisor-scope-other-repo-");
    const runGit = vi.fn().mockResolvedValue("## main\nM  service.ts");
    const broker = new AdvisorEvidenceToolBroker({ repoPath: invokingCwd, runGit });

    const [result] = await broker.execute([{ tool: "git.status", repoPath: otherRepo }]);

    expect(result.status).toBe("ok");
    expect(runGit).toHaveBeenCalledTimes(1);
    // git ran against the explicit repoPath, not the invoking cwd.
    expect(runGit.mock.calls[0][1]).toBe(otherRepo);
  });

  it("5. an unreadable path fails with a clear access result, not a silent fallback", async () => {
    const invokingCwd = tempDir("advisor-scope-cwd-");
    const locked = tempDir("advisor-scope-locked-");
    writeFileSync(join(locked, "secretless.txt"), "not actually secret, just unreadable\n");
    chmodSync(join(locked, "secretless.txt"), 0o000);
    const broker = new AdvisorEvidenceToolBroker({ repoPath: invokingCwd });

    try {
      const [missing] = await broker.execute([
        { tool: "repo.read_file", path: join(locked, "does-not-exist.txt") },
      ]);
      expect(["denied", "unavailable"]).toContain(missing.status);
      expect(missing.content).toBe("");

      if (process.getuid?.() !== 0) {
        const [unreadable] = await broker.execute([
          { tool: "repo.read_file", path: join(locked, "secretless.txt") },
        ]);
        expect(["denied", "unavailable"]).toContain(unreadable.status);
        expect(unreadable.content).toBe("");
      }
    } finally {
      chmodSync(join(locked, "secretless.txt"), 0o644);
    }
  });

  it("6. write and mutation capabilities remain unavailable — only the read-only tool set is recognised", () => {
    // Widening the filesystem scope to "/" must not widen the tool surface:
    // no write_file/apply_patch/git.commit/push/exec-style tool exists at
    // all — parseAdvisorEvidenceToolRequest rejects each one up front, the
    // same boundary that already rejects an arbitrary "shell" tool.
    for (const tool of ["repo.write_file", "git.commit", "git.push", "git.apply", "shell.exec", "fs.rm", "fs.write"]) {
      expect(() => parseAdvisorEvidenceToolRequest({ tool })).toThrow(/unsupported/i);
    }
  });

  it("7. evidence limits, redaction, and auditing remain intact under the wider scope", async () => {
    const invokingCwd = tempDir("advisor-scope-cwd-");
    const outside = tempDir("advisor-scope-outside-");
    writeFileSync(join(outside, "config.json"), 'AWS_SECRET_ACCESS_KEY=aws-secret-value\n"client_secret": "client-value"\n');
    const audit = vi.fn();
    const broker = new AdvisorEvidenceToolBroker({
      repoPath: invokingCwd,
      audit,
      limits: { maxResultBytes: 1_000 },
    });

    const [result] = await broker.execute([
      { tool: "repo.read_file", path: join(outside, "config.json") },
    ]);

    // Redaction still applies to content read from outside the invoking cwd.
    expect(result.content).not.toContain("aws-secret-value");
    expect(result.content).not.toContain("client-value");
    expect(result.content).toMatch(/REDACTED/);

    // Auditing still fires, still hashes the path, and now also reports the
    // effective cwd and filesystem scope so a future scope error is obvious.
    expect(audit).toHaveBeenCalledTimes(1);
    const event = audit.mock.calls[0][0];
    expect(event.cwd).toBe(invokingCwd);
    expect(event.scopeRoot).toBe("/");
    expect(JSON.stringify(event)).not.toContain(outside);
    expect(event.arguments.pathSha256).toMatch(/^[a-f0-9]{16}$/);
  });
});
