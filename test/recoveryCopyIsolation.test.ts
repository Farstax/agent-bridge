import Database from "better-sqlite3";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { isolateRecoveryCopyDatabase, recoveryCopySurfaceIdentity } from "../src/db/recoveryCopyIsolation.js";
import { BridgeEngine } from "../src/engine.js";
import { TELEGRAM_SURFACE_CAPABILITIES } from "../src/platform.js";
import { requestAgentBridgeOutcome } from "../src/runOutcome.js";
import { type as eventType } from "../src/events/types.js";

const cutoff = "2026-10-24T16:00:00.000Z";
const copyId = "ws_copy123";
const sourceIdentity = "telegram:interactive";
const copyIdentity = `${sourceIdentity}:recovery:${copyId}`;

function seed(raw: Database.Database): void {
  raw.prepare(`INSERT INTO bridge_state (surface_identity, chat_id, claude_session_id, claude_session_created_at, last_update_id, interactive_cli_preference)
    VALUES (?, ?, ?, ?, ?, ?)`).run(sourceIdentity, "456", "inherited-session", "2026-10-23T12:00:00.000Z", 91, "claude");
  raw.prepare("UPDATE bridge_state SET gemini_session_id = 'legacy-inherited-gemini', kimchi_session_id = 'inherited-kimchi', kimchi_session_created_at = '2026-10-23T12:00:00.000Z' WHERE surface_identity = ? AND chat_id = '456'").run(sourceIdentity);
  raw.prepare(`INSERT INTO conversation_turns (chat_key, role, text, cli, created_at, surface_identity, owner_key)
    VALUES ('456', 'user', 'historical prompt retained', 'claude', '2026-10-23T12:00:00.000Z', ?, 'owner')`).run(sourceIdentity);
  raw.prepare(`INSERT INTO conversation_turns (chat_key, role, text, cli, created_at, surface_identity, owner_key)
    VALUES ('456', 'user', 'post-copy Hello retained', 'claude', '2026-10-25T12:00:00.000Z', ?, 'owner')`).run(sourceIdentity);
  raw.prepare(`INSERT INTO conversation_summaries (chat_key, range_start_turn_id, range_end_turn_id, summary_md, created_at)
    VALUES ('456', 1, 1, 'historical summary retained', '2026-10-23T12:00:00.000Z')`).run();
  raw.prepare(`INSERT INTO conversation_summaries (chat_key, range_start_turn_id, range_end_turn_id, summary_md, created_at)
    VALUES ('456', 2, 2, 'copy summary retained', '2026-10-25T12:00:00.000Z')`).run();
  raw.prepare(`INSERT INTO bridge_runs (run_id, surface_identity, chat_id, bot, status, started_at)
    VALUES ('inherited-run', ?, '456', 'claude', 'running', '2026-10-23T12:00:00.000Z')`).run(sourceIdentity);
  raw.prepare(`INSERT INTO bridge_runs (run_id, surface_identity, chat_id, bot, status, started_at)
    VALUES ('copy-run', ?, '456', 'claude', 'done', '2026-10-25T12:00:00.000Z')`).run(sourceIdentity);
  raw.prepare(`INSERT INTO bridge_runs (run_id, surface_identity, chat_id, bot, status, started_at)
    VALUES ('unrelated-running-run', 'slack:workspace', 'C123', 'claude', 'running', '2026-10-23T12:00:00.000Z')`).run();
  raw.prepare(`INSERT INTO bridge_runs (run_id, surface_identity, chat_id, bot, status, started_at)
    VALUES ('post-cutoff-running-run', ?, '456', 'claude', 'running', '2026-10-25T12:00:00.000Z')`).run(sourceIdentity);
  raw.prepare(`INSERT INTO pending_messages (surface, chat_key, prompt, chat_id, state, created_at)
    VALUES (?, '456', 'inherited pending', 456, 'queued', '2026-10-23T12:00:00.000Z')`).run(sourceIdentity);
  raw.prepare(`INSERT INTO pending_messages (surface, chat_key, prompt, chat_id, state, created_at)
    VALUES (?, '456', 'post-copy pending', 456, 'queued', '2026-10-25T12:00:00.000Z')`).run(sourceIdentity);
  raw.prepare(`INSERT INTO acp_session_bindings (surface_identity, conversation_id, provider_id, acp_session_id, last_run_id, created_at, updated_at)
    VALUES (?, '456', 'claude', 'post-copy-acp-session', 'copy-run', '2026-10-25T12:00:00.000Z', '2026-10-25T12:00:00.000Z')`).run(sourceIdentity);
  raw.prepare(`INSERT INTO execution_capacity_claims (claim_id, service_id, run_id, acquisition_id, execution_id, acquired_at, lease_expires_at)
    VALUES ('inherited-claim', 'telegram:interactive', 'inherited-run', 'acq', 'exec', '2026-10-23T12:00:00.000Z', '2026-10-27T12:00:00.000Z')`).run();
  raw.prepare(`INSERT INTO execution_capacity_claims (claim_id, service_id, run_id, acquisition_id, execution_id, acquired_at, lease_expires_at)
    VALUES ('post-cutoff-claim', 'telegram:interactive', 'copy-run', 'acq2', 'exec2', '2026-10-25T12:00:00.000Z', '2026-10-27T12:00:00.000Z')`).run();
  raw.prepare(`INSERT INTO execution_locks (surface, chat_key, service_id, run_id, acquisition_id, acquired_at, lease_expires_at)
    VALUES (?, '456', 'telegram:interactive', 'copy-run', 'copy-acq', '2026-10-25T12:00:00.000Z', '2026-10-27T12:00:00.000Z')`).run(sourceIdentity);
  raw.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("run-continuation:v1:inherited", JSON.stringify({
    version: 1, id: "inherited", originRunId: "inherited-run", surfaceIdentity: sourceIdentity, chatKey: "456",
    provider: "claude", reason: "pending inherited task", requestedAt: "2026-10-23T12:00:00.000Z",
    dueAt: "2026-10-28T12:00:00.000Z", expiresAt: "2026-10-29T12:00:00.000Z", state: "pending",
  }));
  raw.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("run-continuation:v1:copy", JSON.stringify({
    version: 1, id: "copy", originRunId: "copy-run", surfaceIdentity: sourceIdentity, chatKey: "456",
    provider: "claude", reason: "copy activity", requestedAt: "2026-10-25T12:00:00.000Z",
    dueAt: "2026-10-28T12:00:00.000Z", expiresAt: "2026-10-29T12:00:00.000Z", state: "pending",
  }));
  raw.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("scheduled-routine:v1:daily", JSON.stringify({
    id: "daily", name: "Daily check", instruction: "routine instruction", kind: "companion",
    surfaceIdentity: sourceIdentity, chatKey: "456", ownerKey: JSON.stringify([sourceIdentity, "42"]), timezone: "Etc/UTC",
    schedule: { type: "weekly", weekdays: [1, 2, 3, 4, 5], time: "09:00" }, enabled: true,
    createdAt: "2026-10-20T12:00:00.000Z", delivery: { chatId: 456, chatType: "private" },
  }));
  raw.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("scheduled-routine-trigger:v1:daily", "2026-10-25T12:00:00.000Z");
}

describe("recovery-copy execution isolation", () => {
  let db: ReturnType<typeof openDb> | undefined;
  let sourceDb: ReturnType<typeof openDb> | undefined;
  let dir: string | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
    sourceDb?.close();
    sourceDb = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("keeps history and post-copy Telegram/Claude activity while fencing inherited execution", () => {
    db = openDb(":memory:", { databaseRole: "interactive" });
    seed(db.raw);
    const result = isolateRecoveryCopyDatabase(db.raw, { copyId, recoveryPointCreatedAt: cutoff, now: "2026-10-27T12:00:00.000Z" });

    expect(result).toMatchObject({ copyId, runsFenced: 2, continuationsFenced: 1, capacityClaimsArchived: 2, alreadyApplied: false });
    expect(recoveryCopySurfaceIdentity(db.raw, sourceIdentity)).toBe(copyIdentity);
    expect(db.raw.prepare("SELECT status, error FROM bridge_runs WHERE run_id = 'inherited-run'").get()).toMatchObject({ status: "cancelled", error: expect.stringContaining("inherited execution fenced") });
    expect(db.raw.prepare("SELECT status FROM bridge_runs WHERE run_id = 'unrelated-running-run'").get()).toEqual({ status: "running" });
    expect(db.raw.prepare("SELECT status FROM bridge_runs WHERE run_id = 'post-cutoff-running-run'").get()).toEqual({ status: "cancelled" });
    expect(db.raw.prepare("SELECT surface_identity FROM bridge_runs WHERE run_id = 'copy-run'").get()).toEqual({ surface_identity: copyIdentity });
    expect(db.raw.prepare("SELECT text FROM conversation_turns WHERE surface_identity = ? ORDER BY id").all(copyIdentity)).toEqual([
      { text: "historical prompt retained" }, { text: "post-copy Hello retained" },
    ]);
    expect(db.raw.prepare("SELECT text FROM conversation_turns WHERE surface_identity = ?").all(sourceIdentity)).toEqual([]);
    expect(db.raw.prepare("SELECT chat_key FROM conversation_summaries WHERE summary_md = 'historical summary retained'").get()).toEqual({ chat_key: "456" });
    expect(db.raw.prepare("SELECT record_type FROM recovery_copy_execution_archive WHERE record_key = '1'").get()).toEqual({ record_type: "pending_message" });
    expect(db.raw.prepare("SELECT chat_key FROM conversation_summaries WHERE summary_md = 'copy summary retained'").get()).toEqual({ chat_key: "456" });
    expect(db.raw.prepare("SELECT surface, prompt FROM pending_messages ORDER BY id").all()).toEqual([
      { surface: copyIdentity, prompt: "post-copy pending" },
    ]);
    expect(db.raw.prepare("SELECT surface_identity, acp_session_id FROM acp_session_bindings WHERE surface_identity = ?").get(copyIdentity)).toEqual({ surface_identity: copyIdentity, acp_session_id: "post-copy-acp-session" });
    expect(db.raw.prepare("SELECT claude_session_id, gemini_session_id, kimchi_session_id, last_update_id FROM bridge_state WHERE surface_identity = ? AND chat_id = '456'").get(copyIdentity)).toEqual({
      claude_session_id: null, gemini_session_id: null, kimchi_session_id: null, last_update_id: 91,
    });
    expect(db.raw.prepare("SELECT count(*) AS n FROM execution_capacity_claims").get()).toEqual({ n: 0 });
    expect(db.raw.prepare("SELECT count(*) AS n FROM execution_locks").get()).toEqual({ n: 0 });
    expect(db.raw.prepare("SELECT record_type FROM recovery_copy_execution_archive WHERE record_type = 'execution_lock'").get()).toEqual({ record_type: "execution_lock" });
    expect(db.raw.prepare("SELECT record_type, record_key FROM recovery_copy_execution_archive WHERE record_type = 'execution_capacity_claim' ORDER BY record_key").all()).toEqual([
      { record_type: "execution_capacity_claim", record_key: "inherited-claim" },
      { record_type: "execution_capacity_claim", record_key: "post-cutoff-claim" },
    ]);
    const inherited = JSON.parse((db.raw.prepare("SELECT value FROM settings WHERE key = 'run-continuation:v1:inherited'").get() as { value: string }).value);
    const recent = JSON.parse((db.raw.prepare("SELECT value FROM settings WHERE key = 'run-continuation:v1:copy'").get() as { value: string }).value);
    expect(inherited.state).toBe("cancelled");
    expect(recent).toMatchObject({ state: "pending", surfaceIdentity: copyIdentity });
    const routine = JSON.parse((db.raw.prepare("SELECT value FROM settings WHERE key = 'scheduled-routine:v1:daily'").get() as { value: string }).value);
    expect(routine).toMatchObject({ id: "daily", surfaceIdentity: copyIdentity, ownerKey: JSON.stringify([copyIdentity, "42"]), enabled: true });
    expect(db.raw.prepare("SELECT value FROM settings WHERE key = 'scheduled-routine-trigger:v1:daily'").get()).toEqual({ value: "2026-10-25T12:00:00.000Z" });
    expect(db.raw.prepare("SELECT claude_session_id FROM bridge_state WHERE surface_identity = ? AND chat_id = '456'").get(copyIdentity)).toEqual({ claude_session_id: null });
  });

  it("accepts a fresh Telegram Hello on the isolated identity and delivers a Claude response", async () => {
    dir = mkdtempSync(join(tmpdir(), "bridge-recovery-copy-telegram-"));
    const path = join(dir, "interactive.sqlite");
    db = openDb(path, { databaseRole: "interactive" });
    seed(db.raw);
    isolateRecoveryCopyDatabase(db.raw, { copyId, recoveryPointCreatedAt: cutoff, now: "2026-10-27T12:00:00.000Z" });
    const client = {
      capabilities: TELEGRAM_SURFACE_CAPABILITIES,
      sendMessage: vi.fn().mockResolvedValue({ ok: true, result: { message_id: 900 } }),
      sendChatAction: vi.fn().mockResolvedValue({ ok: true }),
      editMessageText: vi.fn().mockResolvedValue({ ok: true }),
      deleteMessage: vi.fn().mockResolvedValue({ ok: true }),
    } as any;
    const invokeClaude = vi.fn(async (_provider: unknown, _invocation: unknown, cwd: string, options: any) => {
      const eventContext = options.eventContext;
      options.onEvent?.(eventType.runStarted({ ...eventContext, command: "claude", cwd, model: null }));
      requestAgentBridgeOutcome(["complete", "--evidence", "deterministic Claude response"], options.contextEnv);
      options.onEvent?.(eventType.runCompleted({ ...eventContext, text: "Claude: Hello there.", sessionId: "fresh-claude-session" }));
      return { text: "Claude: Hello there.", sessionId: "fresh-claude-session", stopReason: "end_turn" };
    });
    const engine = new BridgeEngine({
      surfaceIdentity: recoveryCopySurfaceIdentity(db.raw, sourceIdentity),
      kind: "claude",
      botConfig: { command: "claude", modelPreference: [] },
      allowedUserIds: new Set(["42"]),
      executionMode: "safe",
      busyMessageMode: "queue",
      pollIntervalMs: 1_000,
      fullConfig: { dbPath: path } as any,
    }, db, client, { runProviderInvocation: invokeClaude } as any);

    await engine.recoverPendingQueues();
    expect(invokeClaude).toHaveBeenCalledOnce();
    expect(invokeClaude.mock.calls[0]?.[1].prompt).toContain("post-copy pending");
    expect(invokeClaude.mock.calls[0]?.[1].prompt).not.toContain("inherited pending");
    await engine.handleUpdate({
      update_id: 902,
      message: {
        message_id: 902,
        chat: { id: 456, type: "private" },
        from: { id: 42, first_name: "Operator" },
        text: "Hello",
        date: 1_793_092_800,
      },
    } as any);

    expect(invokeClaude).toHaveBeenCalledTimes(2);
    expect(invokeClaude.mock.calls[1]?.[1].prompt).toContain("Hello");
    const activeContext = db.buildConvContext("456", 50_000, copyIdentity);
    expect(activeContext).toContain("post-copy Hello retained");
    expect(activeContext).toContain("historical prompt retained");
    expect(client.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ chat_id: 456, text: "Claude: Hello there." }));
    expect(db.raw.prepare("SELECT status, bot FROM bridge_runs ORDER BY started_at DESC LIMIT 1").get()).toMatchObject({ status: "done", bot: "claude" });
    expect(db.raw.prepare("SELECT text FROM conversation_turns WHERE surface_identity = ? ORDER BY id DESC LIMIT 2").all(copyIdentity)).toEqual([
      { text: "Claude: Hello there." },
      { text: "Hello" },
    ]);
    expect(db.raw.prepare("SELECT acp_session_id FROM acp_session_bindings WHERE surface_identity = ? AND conversation_id = '456' AND provider_id = 'claude'").get(copyIdentity)).toEqual({ acp_session_id: "fresh-claude-session" });
    const inheritedContinuation = JSON.parse((db.raw.prepare("SELECT value FROM settings WHERE key = 'run-continuation:v1:inherited'").get() as { value: string }).value);
    expect(inheritedContinuation.state).toBe("cancelled");
  });

  it("is idempotent across restart, supports a later recovery point, and rolls back a failed transaction", () => {
    sourceDb = openDb(":memory:", { databaseRole: "interactive" });
    seed(sourceDb.raw);
    dir = mkdtempSync(join(tmpdir(), "bridge-recovery-copy-isolation-"));
    const path = join(dir, "interactive.sqlite");
    db = openDb(path, { databaseRole: "interactive" });
    seed(db.raw);
    db.raw.exec("CREATE TRIGGER reject_recovery_marker BEFORE INSERT ON settings WHEN NEW.key LIKE 'agent_bridge_recovery_copy_isolation:v1:%' BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
    expect(() => isolateRecoveryCopyDatabase(db!.raw, { copyId, recoveryPointCreatedAt: cutoff })).toThrow("injected failure");
    expect(db.raw.prepare("SELECT status FROM bridge_runs WHERE run_id = 'inherited-run'").get()).toEqual({ status: "running" });
    db.raw.exec("DROP TRIGGER reject_recovery_marker");
    isolateRecoveryCopyDatabase(db.raw, { copyId, recoveryPointCreatedAt: cutoff });
    db.close();
    db = undefined;
    db = openDb(path, { databaseRole: "interactive" });
    expect(recoveryCopySurfaceIdentity(db.raw, sourceIdentity)).toBe(copyIdentity);
    expect(isolateRecoveryCopyDatabase(db.raw, { copyId, recoveryPointCreatedAt: cutoff }).alreadyApplied).toBe(true);
    isolateRecoveryCopyDatabase(db.raw, { copyId: "ws_copy456", recoveryPointCreatedAt: "2026-10-25T00:00:00.000Z" });
    expect(recoveryCopySurfaceIdentity(db.raw, sourceIdentity)).toBe(`${sourceIdentity}:recovery:ws_copy456`);
    expect(db.raw.prepare("SELECT text FROM conversation_turns WHERE surface_identity = ? ORDER BY id").all(`${sourceIdentity}:recovery:ws_copy456`)).toEqual([
      { text: "historical prompt retained" }, { text: "post-copy Hello retained" },
    ]);
    expect(sourceDb.raw.prepare("SELECT status FROM bridge_runs WHERE run_id = 'inherited-run'").get()).toEqual({ status: "running" });
    expect(sourceDb.raw.prepare("SELECT value FROM settings WHERE key = 'agent_bridge_recovery_copy_active_identity:v1'").get()).toBeUndefined();
  });

  it("exposes isolation only through the guarded interactive rollout database command", () => {
    dir = mkdtempSync(join(tmpdir(), "bridge-recovery-copy-cli-"));
    const path = join(dir, "interactive.sqlite");
    db = openDb(path, { databaseRole: "interactive" });
    seed(db.raw);
    db.close();
    db = undefined;

    const cli = spawnSync(process.execPath, [
      "--import", "tsx", "scripts/rollout-db.ts", "isolate-recovery-copy",
      "--db", path, "--database-role", `${path}=interactive`, "--copy-id", copyId,
      "--recovery-point-created-at", cutoff,
    ], { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, NODE_ENV: "test" } });

    expect(cli.status, cli.stderr).toBe(0);
    expect(JSON.parse(cli.stdout)).toMatchObject({ copyId, runsFenced: 2, alreadyApplied: false });
    db = openDb(path, { databaseRole: "interactive" });
    expect(db.raw.prepare("SELECT status FROM bridge_runs WHERE run_id = 'inherited-run'").get()).toEqual({ status: "cancelled" });
  }, 15_000);

  it("refuses production isolation while an Agent Bridge service is active", () => {
    dir = mkdtempSync(join(tmpdir(), "bridge-recovery-copy-active-unit-"));
    const path = join(dir, "interactive.sqlite");
    db = openDb(path, { databaseRole: "interactive" });
    seed(db.raw);
    db.close();
    db = undefined;
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const systemctl = join(bin, "systemctl");
    writeFileSync(systemctl, "#!/bin/sh\nprintf '%s\\n' 'agent-bridge-interactive.service loaded active running Interactive'\n");
    chmodSync(systemctl, 0o755);

    const cli = spawnSync(process.execPath, [
      "--import", "tsx", "scripts/rollout-db.ts", "isolate-recovery-copy",
      "--db", path, "--database-role", `${path}=interactive`, "--copy-id", copyId,
      "--recovery-point-created-at", cutoff,
    ], { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, NODE_ENV: "production", PATH: `${bin}:${process.env.PATH ?? ""}` } });

    expect(cli.status).not.toBe(0);
    expect(cli.stderr).toContain("requires stopped Agent Bridge services");
    db = openDb(path, { databaseRole: "interactive" });
    expect(db.raw.prepare("SELECT status FROM bridge_runs WHERE run_id = 'inherited-run'").get()).toEqual({ status: "running" });
  }, 15_000);
});
