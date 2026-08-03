import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("integrated health service lifecycle", () => {
  it("stays alive with the default disabled scheduler", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-bridge-health-lifecycle-"));
    const dbPath = join(directory, "health.sqlite");
    execFileSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/rollout-db.ts", "bootstrap", "--db", dbPath, "--role", "health", "--confirm-new-role", dbPath], {
      cwd: process.cwd(), stdio: "pipe",
    });
    const child = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "src/index-health.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HEALTH_BOT_MODE: "integrated",
        HEALTH_MONITOR_ENABLED: "false",
        HEALTH_DB_PATH: dbPath,
        TELEGRAM_BOT_TOKEN_INTERACTIVE: "test-token",
        TELEGRAM_ALLOWED_USER_IDS: "1",
        BRIDGE_ENV_FILE: join(directory, "missing.env"),
      },
      stdio: "ignore",
    });
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    try {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(child.exitCode).toBeNull();
    } finally {
      if (child.exitCode === null) child.kill("SIGTERM");
      await closed;
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15_000);
});
