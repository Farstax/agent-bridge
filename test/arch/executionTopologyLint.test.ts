import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = join(__dirname, "..", "..", "scripts", "arch-lint.sh");

function runLint(dir: string): { code: number; output: string } {
  try {
    const output = execFileSync("bash", [SCRIPT, dir], { encoding: "utf8" });
    return { code: 0, output };
  } catch (error: any) {
    return {
      code: error.status ?? 1,
      output: `${error.stdout ?? ""}${error.stderr ?? ""}`,
    };
  }
}

describe("execution topology architecture lint", () => {
  it("rejects conversation recording outside the engine", () => {
    const dir = mkdtempSync(join(tmpdir(), "archlint-topology-turns-"));
    try {
      writeFileSync(join(dir, "index-interactive.ts"), "fallbackChain.addTurn('user', 'hello');\n");
      const result = runLint(dir);
      expect(result.code).toBe(1);
      expect(result.output).toContain("execution topology ownership must remain with the engine");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects duplicate context preamble injection in dispatchers", () => {
    const dir = mkdtempSync(join(tmpdir(), "archlint-topology-context-"));
    try {
      writeFileSync(join(dir, "providerFallback.ts"), "buildContextPreamble();\n");
      const result = runLint(dir);
      expect(result.code).toBe(1);
      expect(result.output).toContain("execution topology ownership must remain with the engine");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a second Engineering Worker execution path", () => {
    const dir = mkdtempSync(join(tmpdir(), "archlint-topology-worker-"));
    try {
      writeFileSync(join(dir, "worker.ts"), "export const chain = process.env.WORKER_CLI_CHAIN;\n");
      const result = runLint(dir);
      expect(result.code).toBe(1);
      expect(result.output).toContain("Engineering Worker execution path must not be reintroduced");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
