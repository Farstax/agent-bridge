import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = join(__dirname, "..", "..", "scripts", "arch-lint.sh");

function runLint(dir: string): { code: number; output: string } {
  try {
    const output = execFileSync("bash", [SCRIPT, join(dir, "src")], { encoding: "utf8" });
    return { code: 0, output };
  } catch (error: any) {
    return {
      code: error.status ?? 1,
      output: `${error.stdout ?? ""}${error.stderr ?? ""}`,
    };
  }
}

describe("ACP ownership architecture lint", () => {
  it("rejects provider-derived environment compatibility in shared session planning", () => {
    const dir = mkdtempSync(join(tmpdir(), "archlint-acp-session-owner-"));
    try {
      mkdirSync(join(dir, "src", "acp"), { recursive: true });
      writeFileSync(
        join(dir, "src", "acp", "sessionConfig.ts"),
        "const key = `${providerId.toUpperCase()}_MODEL_PREFERENCE`;\n",
      );
      const result = runLint(dir);
      expect(result.code).toBe(1);
      expect(result.output).toContain("shared ACP ownership must remain provider-neutral");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects migrated-provider auth compatibility aliases in shared auth", () => {
    const dir = mkdtempSync(join(tmpdir(), "archlint-acp-auth-owner-"));
    try {
      mkdirSync(join(dir, "src", "providers"), { recursive: true });
      writeFileSync(
        join(dir, "src", "providers", "apiKeyAuth.ts"),
        "export type CodexAcpApiKeyProbeExecutor = unknown;\n",
      );
      const result = runLint(dir);
      expect(result.code).toBe(1);
      expect(result.output).toContain("shared ACP ownership must remain provider-neutral");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects migrated-provider branches in shared credential filtering", () => {
    const dir = mkdtempSync(join(tmpdir(), "archlint-acp-auth-branch-"));
    try {
      mkdirSync(join(dir, "src", "providers"), { recursive: true });
      writeFileSync(
        join(dir, "src", "providers", "apiKeyAuth.ts"),
        'if (provider === "claude") out.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = "1";\n',
      );
      const result = runLint(dir);
      expect(result.code).toBe(1);
      expect(result.output).toContain("shared ACP ownership must remain provider-neutral");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
