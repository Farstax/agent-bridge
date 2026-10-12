import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const tsx = resolve("node_modules/.bin/tsx");
const entrypoint = resolve("scripts/provider-qualification.ts");

function run(stagedExecutable: string) {
  return spawnSync(tsx, [entrypoint, "--provider", "agy", "--staged-executable", stagedExecutable], {
    encoding: "utf8",
    env: { ...process.env, AGENT_BRIDGE_ENVIRONMENT_CLASS: "test" },
    timeout: 60_000,
  });
}

describe("explicit staged qualification entrypoint (issue 997)", () => {
  it("rejects a staged executable that is not absolute, executable or owner-only writable", () => {
    const root = mkdtempSync(join(tmpdir(), "staged-qualification-entrypoint-"));
    const plain = join(root, "plain");
    const writable = join(root, "writable");
    for (const path of [plain, writable]) writeFileSync(path, "#!/bin/sh\nexit 0\n");
    chmodSync(plain, 0o644);
    chmodSync(writable, 0o777);

    const relative = run("relative/agy");
    expect(relative.status).toBe(2);
    expect(relative.stderr).toMatch(/must be an absolute path/);

    const notExecutable = run(plain);
    expect(notExecutable.status).toBe(2);
    expect(notExecutable.stderr).toMatch(/not executable/);

    const printEnv = spawnSync(tsx, [entrypoint, "--provider", "agy", "--staged-executable", plain, "--print-env"], {
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(printEnv.status).toBe(2);
    expect(printEnv.stderr).toMatch(/--print-env cannot be combined with --staged-executable/);

    const unsafe = run(writable);
    expect(unsafe.status).toBe(2);
    expect(unsafe.stderr).toMatch(/group- or world-writable/);
  });

  it("rejects --staged-executable without explicit --evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "staged-entrypoint-no-evidence-"));
    const candidate = join(root, "agy");
    writeFileSync(candidate, "#!/bin/sh\nexit 0\n");
    chmodSync(candidate, 0o755);

    const noEvidence = spawnSync(tsx, [entrypoint, "--provider", "agy", "--staged-executable", candidate], {
      encoding: "utf8",
      env: { ...process.env, AGENT_BRIDGE_ENVIRONMENT_CLASS: "test" },
      timeout: 60_000,
    });
    expect(noEvidence.status).toBe(2);
    expect(noEvidence.stderr).toMatch(/--staged-executable requires --evidence/);
  });
});
