import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCliAsync } from "../src/cli.js";

const cwd = mkdtempSync(join(tmpdir(), "agent-bridge-643-cli-"));

afterAll(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("issue #643 CLI exit diagnostics", () => {
  it("marks a silent nonzero exit explicitly and exposes only safe diagnostic metadata", async () => {
    let thrown: any = null;
    try {
      await runCliAsync(process.execPath, ["-e", "process.exit(1)"], cwd, { bot: "claude" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.message).toBe("CLI exited with code 1: (no diagnostic output)");
    expect(thrown.exitCode).toBe(1);
    expect(thrown.signal).toBeNull();
    expect(thrown.rawOutputBytes).toBe(0);
    expect(thrown.safeOutputBytes).toBe(0);
    expect(thrown.redactionApplied).toBe(false);
  });

  it("retains safe diagnostics and records whether redaction changed provider output", async () => {
    const secret = "issue-643-secret";
    let thrown: any = null;
    try {
      await runCliAsync(
        process.execPath,
        ["-e", `process.stderr.write(${JSON.stringify(secret)}); process.exit(1)`],
        cwd,
        { bot: "claude", contextEnv: { OPENAI_API_KEY: secret } },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.message).toContain("[REDACTED_PROVIDER_CREDENTIAL]");
    expect(thrown.message).not.toContain(secret);
    expect(thrown.message).not.toContain("(no diagnostic output)");
    expect(thrown.rawOutputBytes).toBeGreaterThan(0);
    expect(thrown.safeOutputBytes).toBeGreaterThan(0);
    expect(thrown.redactionApplied).toBe(true);
  });
});
