import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

describe("guarded health database relocation", () => {
  it("backs up the complete cohort before attempting relocation", () => {
    const rollout = readFileSync(new URL("../scripts/rollout-agent-bridge.sh", import.meta.url), "utf8");
    const backup = rollout.indexOf("backup_databases\nbackup_completed=1");
    const relocation = rollout.indexOf('run_db_tool relocate --from "$health_relocation_source"');
    expect(backup).toBeGreaterThan(-1);
    expect(relocation).toBeGreaterThan(backup);
  });

  it("copies an existing legacy database only when the target is absent", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-health-relocation-"));
    try {
      const source = join(root, "legacy", "health.sqlite");
      const target = join(root, "runtime", "health.sqlite");
      mkdirSync(join(root, "legacy"));
      const db = new Database(source);
      db.exec("PRAGMA journal_mode=WAL; CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES ('preserved');");
      db.close();

      execFileSync(process.execPath, ["--import", "tsx", "scripts/rollout-db.ts", "relocate", "--from", source, "--to", target], {
        cwd: process.cwd(),
        env: { ...process.env, AGENT_BRIDGE_ROLLOUT_TEST_ROOT: root },
        stdio: "pipe",
      });

      expect(existsSync(source)).toBe(true);
      expect(existsSync(target)).toBe(true);
      const relocated = new Database(target, { readonly: true });
      expect(relocated.prepare("SELECT value FROM marker").get()).toEqual({ value: "preserved" });
      relocated.close();

      expect(() => execFileSync(process.execPath, ["--import", "tsx", "scripts/rollout-db.ts", "relocate", "--from", source, "--to", target], {
        cwd: process.cwd(),
        env: { ...process.env, AGENT_BRIDGE_ROLLOUT_TEST_ROOT: root },
        stdio: "pipe",
      })).toThrow();
      expect(existsSync(source)).toBe(true);
      const sourceAfterFailure = new Database(source, { readonly: true });
      expect(sourceAfterFailure.prepare("SELECT value FROM marker").get()).toEqual({ value: "preserved" });
      sourceAfterFailure.close();
      expect(existsSync(target)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
