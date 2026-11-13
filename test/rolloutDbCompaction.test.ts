import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { getBundledRolloutDb } from "./support/rolloutDbBundled.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rollout-compact-"));
  roots.push(root);
  const path = join(root, "interactive.sqlite");
  const db = openDb(path);
  db.close();
  const sqlite = new Database(path);
  sqlite.exec("CREATE TABLE temporary_bloat(value BLOB)");
  sqlite.exec("INSERT INTO temporary_bloat VALUES (zeroblob(70 * 1024 * 1024))");
  sqlite.exec("DROP TABLE temporary_bloat");
  sqlite.close();
  return path;
}

function run(path: string, mode: "compact" | "prune") {
  return JSON.parse(execFileSync(process.execPath, [getBundledRolloutDb(), mode, "--db", path,
    "--database-role", `${path}=interactive`, "--resolving-unit", `${path}=agent-bridge-interactive.service`, "--evidence", "-"], { encoding: "utf8" }));
}

describe("offline SQLite compaction", { timeout: 30_000 }, () => {
  it("shrinks free pages without changing schema or conversation data", () => {
    const path = fixture();
    const before = statSync(path).size;
    const evidence = run(path, "compact").databases[0];
    const after = statSync(path).size;
    expect(before - after).toBeGreaterThan(64 * 1024 * 1024);
    expect(evidence.compaction.fileBytesBefore).toBe(before);
    expect(evidence.compaction.fileBytesAfter).toBe(after);
    expect(evidence.integrity).toBe("ok");
    expect(evidence.sqliteStorage.freePages).toBeLessThan(100);
    const db = openDb(path);
    expect(db.raw.pragma("integrity_check", { simple: true })).toBe("ok");
    db.close();
  });

  it("does not compact when called through the daily prune mode", () => {
    const path = fixture();
    const before = statSync(path).size;
    const evidence = run(path, "prune").databases[0];
    expect(evidence.acpTelemetryRetention.compacted).toBe(false);
    expect(statSync(path).size).toBe(before);
  });

  it("refuses needless compaction on an already compacted database", () => {
    const path = fixture();
    run(path, "compact");
    expect(() => run(path, "compact")).toThrow();
  });
});
