import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

// Issue #135 Phase 4C.3: `rollout-db.ts inspect` gains a per-database
// "resolving units" evidence field (policy doc §4/§6.3) — the set of
// systemd units that resolve to each canonical database file, sourced from
// the same unit/env resolution rollout-agent-bridge.sh already performs and
// passed in as evidence input rather than re-derived inside rollout-db.ts.

const migrationScript = fileURLToPath(new URL("../scripts/rollout-db.ts", import.meta.url));
const tsxCli = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "rollout-db-units-"));
  dirs.push(dir);
  return dir;
}

function createCurrentDb(path: string): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE bridge_state (chat_id TEXT PRIMARY KEY, active_execution_lock INTEGER NOT NULL DEFAULT 0, last_update_id INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE pending_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, chat_key TEXT NOT NULL, prompt TEXT NOT NULL, chat_id INTEGER NOT NULL,
      thread_id INTEGER, chat_type TEXT NOT NULL DEFAULT 'private', user_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      surface TEXT NOT NULL DEFAULT 'telegram', state TEXT NOT NULL DEFAULT 'pending',
      claim_run_id TEXT, claim_acquisition_id TEXT, claimed_at TEXT, attachments_json TEXT
    );
    CREATE TABLE execution_locks (
      surface TEXT NOT NULL, chat_key TEXT NOT NULL, service_id TEXT NOT NULL, run_id TEXT NOT NULL,
      acquisition_id TEXT NOT NULL, acquired_at TEXT NOT NULL, lease_expires_at TEXT NOT NULL,
      PRIMARY KEY (surface, chat_key)
    );
    PRAGMA user_version = 1;
  `);
  db.close();
}

function runInspect(args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [tsxCli, migrationScript, "inspect", ...args], { encoding: "utf8" });
    return { status: 0, stdout, stderr: "" };
  } catch (err: any) {
    return { status: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("rollout-db.ts inspect resolving-units evidence", () => {
  it("attaches the resolving unit(s) passed via --resolving-unit to the matching database's evidence", () => {
    const dir = tempDir();
    const dbPath = join(dir, "bridge.sqlite");
    createCurrentDb(dbPath);
    const evidencePath = join(dir, "evidence.json");
    const res = runInspect([
      "--db", dbPath,
      "--resolving-unit", `${dbPath}=agent-bridge-antigravity.service`,
      "--resolving-unit", `${dbPath}=agent-bridge-claude.service`,
      "--resolving-unit", `${dbPath}=agent-bridge-codex.service`,
      "--evidence", evidencePath,
    ]);
    expect(res.status, res.stderr).toBe(0);
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
    expect(evidence.databases[0].resolvingUnits).toEqual([
      "agent-bridge-antigravity.service",
      "agent-bridge-claude.service",
      "agent-bridge-codex.service",
    ]);
  });

  it("defaults to an empty array when no --resolving-unit is passed for a database", () => {
    const dir = tempDir();
    const dbPath = join(dir, "bridge.sqlite");
    createCurrentDb(dbPath);
    const evidencePath = join(dir, "evidence.json");
    const res = runInspect(["--db", dbPath, "--evidence", evidencePath]);
    expect(res.status, res.stderr).toBe(0);
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
    expect(evidence.databases[0].resolvingUnits).toEqual([]);
  });

  it("keeps each database's resolving units independent when multiple databases are inspected together", () => {
    const dir = tempDir();
    const first = join(dir, "a.sqlite");
    const second = join(dir, "b.sqlite");
    createCurrentDb(first);
    createCurrentDb(second);
    const evidencePath = join(dir, "evidence.json");
    const res = runInspect([
      "--db", first,
      "--db", second,
      "--resolving-unit", `${first}=agent-bridge-interactive.service`,
      "--resolving-unit", `${second}=agent-bridge-health.service`,
      "--evidence", evidencePath,
    ]);
    expect(res.status, res.stderr).toBe(0);
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
    const byPath = Object.fromEntries(evidence.databases.map((d: any) => [d.path, d.resolvingUnits]));
    expect(byPath[first]).toEqual(["agent-bridge-interactive.service"]);
    expect(byPath[second]).toEqual(["agent-bridge-health.service"]);
  });

  it("rejects a malformed --resolving-unit value with no '=' separator", () => {
    const dir = tempDir();
    const dbPath = join(dir, "bridge.sqlite");
    createCurrentDb(dbPath);
    const res = runInspect(["--db", dbPath, "--resolving-unit", "not-a-valid-pair"]);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/resolving-unit/i);
  });
});
