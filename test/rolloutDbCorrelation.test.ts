import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const rolloutDb = fileURLToPath(new URL("../scripts/rollout-db.ts", import.meta.url));
const tsx = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));
const acceptance = fileURLToPath(new URL("../scripts/rollout-acceptance.py", import.meta.url));

function createDatabase(path: string): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE bridge_state (chat_id TEXT PRIMARY KEY, active_execution_lock INTEGER NOT NULL DEFAULT 0, last_update_id INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE pending_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_key TEXT NOT NULL, prompt TEXT NOT NULL, chat_id INTEGER NOT NULL, thread_id INTEGER, chat_type TEXT NOT NULL DEFAULT 'private', user_id INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, surface TEXT NOT NULL DEFAULT 'telegram', state TEXT NOT NULL DEFAULT 'pending', claim_run_id TEXT, claim_acquisition_id TEXT, claimed_at TEXT, attachments_json TEXT);
    CREATE TABLE execution_locks (surface TEXT NOT NULL, chat_key TEXT NOT NULL, service_id TEXT NOT NULL, run_id TEXT NOT NULL, acquisition_id TEXT NOT NULL, acquired_at TEXT NOT NULL, lease_expires_at TEXT NOT NULL, PRIMARY KEY (surface, chat_key));
    CREATE TABLE bridge_runs (run_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, bot TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, session_id TEXT, final_text_preview TEXT, error TEXT);
    CREATE TABLE bridge_events (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL, timestamp TEXT NOT NULL, payload_json TEXT NOT NULL);
    PRAGMA user_version = 1;
  `);
  db.prepare("INSERT INTO bridge_runs VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)").run("run-1", "chat-1", "codex", "running", "2026-07-26T12:00:00Z");
  db.prepare("INSERT INTO bridge_events VALUES (?, ?, ?, ?, ?, ?)").run("run-1:1", "run-1", 1, "run.started", "2026-07-26T12:00:00Z", "{}");
  db.close();
}

function inspect(path: string, output: string): void {
  execFileSync(process.execPath, [tsx, rolloutDb, "inspect", "--db", path, "--evidence", output], { encoding: "utf8" });
}

describe("rollout database durable identity correlation", () => {
  it("rejects a replacement run with unchanged queue/status counts", () => {
    const root = mkdtempSync(join(tmpdir(), "rollout-db-correlation-"));
    try {
      const dbPath = join(root, "bridge.sqlite");
      const beforePath = join(root, "before.json");
      const afterPath = join(root, "after.json");
      const resultPath = join(root, "acceptance.json");
      createDatabase(dbPath);
      inspect(dbPath, beforePath);
      const db = new Database(dbPath);
      db.exec("DELETE FROM bridge_events; DELETE FROM bridge_runs;");
      db.prepare("INSERT INTO bridge_runs VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)").run("replacement-run", "chat-1", "codex", "running", "2026-07-26T12:00:00Z");
      db.prepare("INSERT INTO bridge_events VALUES (?, ?, ?, ?, ?, ?)").run("replacement-run:1", "replacement-run", 1, "run.started", "2026-07-26T12:00:00Z", "{}");
      db.close();
      inspect(dbPath, afterPath);

      expect(() => execFileSync("python3", [acceptance, "--before", beforePath, "--after", afterPath, "--output", resultPath], { encoding: "utf8" })).toThrow(/identity|delivery|replay/i);
      expect(JSON.parse(readFileSync(beforePath, "utf8")).databases[0].runIdentityCorrelation[0].run_id).toBe("run-1");
      expect(JSON.parse(readFileSync(afterPath, "utf8")).databases[0].runIdentityCorrelation[0].run_id).toBe("replacement-run");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
