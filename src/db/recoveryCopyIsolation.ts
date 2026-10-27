import type Database from "better-sqlite3";

const MARKER_PREFIX = "agent_bridge_recovery_copy_isolation:v1:";
const CONTINUATION_PREFIX = "run-continuation:v1:";

export interface RecoveryCopyIsolationInput {
  copyId: string;
  recoveryPointCreatedAt: string;
  now?: string;
}

export interface RecoveryCopyIsolationResult {
  copyId: string;
  surfaceIdentities: number;
  runsFenced: number;
  continuationsFenced: number;
  capacityClaimsArchived: number;
  alreadyApplied: boolean;
}

function validTime(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function isAfterCutoff(value: unknown, cutoff: string): boolean {
  return typeof value === "string" && validTime(value) && Date.parse(value) >= Date.parse(cutoff);
}

function isolatedIdentity(identity: string, copyId: string): string {
  const baseIdentity = identity.split(":recovery:", 1)[0]!;
  return `${baseIdentity}:recovery:${copyId}`;
}

function parseRecord(value: string): Record<string, unknown> | null {
  try {
    const result: unknown = JSON.parse(value);
    return result && typeof result === "object" && !Array.isArray(result)
      ? result as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/**
 * Separates execution state in a recovery copy while preserving its database
 * image. Rows created after the selected recovery point belong to the new
 * workspace and move into its scoped identity; older conversation evidence
 * remains in place but cannot be selected by the copy's runtime. The caller
 * must stop the guest's Agent Bridge units and run this inside the guarded
 * database rollout lifecycle before re-enabling any surface.
 */
export function isolateRecoveryCopyDatabase(
  db: Database.Database,
  input: RecoveryCopyIsolationInput,
): RecoveryCopyIsolationResult {
  const copyId = input.copyId.trim();
  if (!/^ws_[a-zA-Z0-9]+$/.test(copyId)) throw new Error("recovery copy identity is invalid");
  if (!validTime(input.recoveryPointCreatedAt)) throw new Error("recovery point timestamp is invalid");
  const now = input.now ?? new Date().toISOString();
  if (!validTime(now)) throw new Error("recovery isolation timestamp is invalid");
  const cutoff = new Date(Date.parse(input.recoveryPointCreatedAt)).toISOString();
  const markerKey = `${MARKER_PREFIX}${copyId}`;
  const marker = db.prepare("SELECT value FROM settings WHERE key = ?").get(markerKey) as { value: string } | undefined;
  if (marker) {
    const prior = parseRecord(marker.value);
    if (prior?.recoveryPointCreatedAt !== cutoff) throw new Error("recovery copy identity was already applied with another recovery point");
    return {
      copyId,
      surfaceIdentities: Number(prior.surfaceIdentities ?? 0),
      runsFenced: Number(prior.runsFenced ?? 0),
      continuationsFenced: Number(prior.continuationsFenced ?? 0),
      capacityClaimsArchived: Number(prior.capacityClaimsArchived ?? 0),
      alreadyApplied: true,
    };
  }

  const tx = db.transaction(() => {
    const surfaces = new Set<string>();
    const addSurfaces = (table: string, column: string, condition = ""): void => {
      const rows = db.prepare(`SELECT DISTINCT ${column} AS identity FROM ${table} ${condition}`).all() as Array<{ identity: string | null }>;
      for (const row of rows) if (typeof row.identity === "string" && row.identity.startsWith("telegram:")) surfaces.add(row.identity);
    };
    addSurfaces("bridge_state", "surface_identity");
    // arch-lint-allow-legacy-sql: recovery identity migration owns this bounded read.
    const conversationSurfaces = db.prepare("SELECT DISTINCT surface_identity AS identity FROM conversation_turns").all() as Array<{ identity: string | null }>;
    for (const row of conversationSurfaces) if (typeof row.identity === "string" && row.identity.startsWith("telegram:")) surfaces.add(row.identity);
    addSurfaces("bridge_runs", "surface_identity");
    addSurfaces("acp_session_bindings", "surface_identity");
    addSurfaces("pending_messages", "surface");
    addSurfaces("execution_locks", "surface");

    let runsFenced = 0;
    // Only Telegram Runs belong to this copy-specific surface migration; other
    // interactive surfaces retain their own runtime identity and execution state.
    const staleRuns = db.prepare("SELECT run_id FROM bridge_runs WHERE status = 'running' AND started_at < ? AND surface_identity LIKE 'telegram:%'").all(cutoff) as Array<{ run_id: string }>;
    for (const { run_id: runId } of staleRuns) {
      const seq = (db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM bridge_events WHERE run_id = ?").get(runId) as { next: number }).next;
      const result = db.prepare(`UPDATE bridge_runs SET status = 'cancelled', ended_at = ?, error = ? WHERE run_id = ? AND status = 'running'`)
        .run(now, "inherited execution fenced during recovery-copy isolation", runId);
      if (result.changes !== 1) continue;
      db.prepare(`INSERT INTO bridge_events (id, run_id, seq, type, timestamp, payload_json) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(`${runId}:${seq}`, runId, seq, "recovery_copy.inherited_run_fenced", now, JSON.stringify({ copyId, recoveryPointCreatedAt: cutoff }));
      runsFenced += 1;
    }

    const runRows = db.prepare("SELECT run_id, surface_identity, started_at FROM bridge_runs WHERE surface_identity LIKE 'telegram:%'").all() as Array<{ run_id: string; surface_identity: string; started_at: string }>;
    for (const run of runRows) {
      db.prepare("UPDATE bridge_runs SET surface_identity = ? WHERE run_id = ?")
        .run(isolatedIdentity(run.surface_identity, copyId), run.run_id);
    }

    // arch-lint-allow-legacy-sql: recovery identity migration owns this bounded read.
    const turnRows = db.prepare("SELECT id, surface_identity, created_at FROM conversation_turns WHERE surface_identity LIKE 'telegram:%'").all() as Array<{ id: number; surface_identity: string; created_at: string }>;
    for (const turn of turnRows) {
      // arch-lint-allow-legacy-sql: recovery identity migration owns this scoped rewrite.
      db.prepare("UPDATE conversation_turns SET surface_identity = ? WHERE id = ?")
        .run(isolatedIdentity(turn.surface_identity, copyId), turn.id);
    }

    const bindingRows = db.prepare("SELECT surface_identity, conversation_id, provider_id, updated_at FROM acp_session_bindings WHERE surface_identity LIKE 'telegram:%'").all() as Array<{ surface_identity: string; conversation_id: string; provider_id: string; updated_at: string }>;
    for (const binding of bindingRows) {
      if (!isAfterCutoff(binding.updated_at, cutoff)) continue;
      const destination = isolatedIdentity(binding.surface_identity, copyId);
      db.prepare(`INSERT INTO acp_session_bindings (surface_identity, conversation_id, provider_id, acp_session_id, last_run_id, created_at, updated_at)
        SELECT ?, conversation_id, provider_id, acp_session_id, last_run_id, created_at, updated_at
          FROM acp_session_bindings WHERE surface_identity = ? AND conversation_id = ? AND provider_id = ?
        ON CONFLICT(surface_identity, conversation_id, provider_id) DO UPDATE SET
          acp_session_id = CASE WHEN excluded.updated_at >= acp_session_bindings.updated_at THEN excluded.acp_session_id ELSE acp_session_bindings.acp_session_id END,
          last_run_id = CASE WHEN excluded.updated_at >= acp_session_bindings.updated_at THEN excluded.last_run_id ELSE acp_session_bindings.last_run_id END,
          updated_at = MAX(excluded.updated_at, acp_session_bindings.updated_at)`)
        .run(destination, binding.surface_identity, binding.conversation_id, binding.provider_id);
    }

    const pendingRows = db.prepare("SELECT * FROM pending_messages WHERE surface LIKE 'telegram:%'").all() as Array<Record<string, unknown>>;
    for (const pending of pendingRows) {
      if (!isAfterCutoff(pending.created_at, cutoff)) {
        db.prepare(`INSERT OR IGNORE INTO recovery_copy_execution_archive
          (copy_id, record_type, record_key, payload_json, archived_at) VALUES (?, 'pending_message', ?, ?, ?)`)
          .run(copyId, String(pending.id), JSON.stringify(pending), now);
        db.prepare("DELETE FROM pending_messages WHERE id = ?").run(pending.id);
        continue;
      }
      db.prepare("UPDATE pending_messages SET surface = ? WHERE id = ?")
        .run(isolatedIdentity(String(pending.surface), copyId), pending.id);
    }

    const lockRows = db.prepare("SELECT surface, chat_key, acquired_at FROM execution_locks WHERE surface LIKE 'telegram:%'").all() as Array<{ surface: string; chat_key: string; acquired_at: string }>;
    for (const lock of lockRows) {
      // Locks are leases owned by an in-flight process, never durable copy activity.
      // Preserve their evidence, but do not transfer any lock across recovery points.
      const fullLock = db.prepare("SELECT * FROM execution_locks WHERE surface = ? AND chat_key = ?").get(lock.surface, lock.chat_key);
      if (fullLock) {
        db.prepare(`INSERT OR IGNORE INTO recovery_copy_execution_archive
          (copy_id, record_type, record_key, payload_json, archived_at) VALUES (?, 'execution_lock', ?, ?, ?)`)
          .run(copyId, `${lock.surface}:${lock.chat_key}`, JSON.stringify(fullLock), now);
      }
      db.prepare("DELETE FROM execution_locks WHERE surface = ? AND chat_key = ?").run(lock.surface, lock.chat_key);
    }

    const stateRows = db.prepare("SELECT * FROM bridge_state WHERE surface_identity LIKE 'telegram:%'").all() as Array<Record<string, unknown>>;
    const sessionColumns = ["codex", "claude", "antigravity", "kimchi", "grok", "cursor"] as const;
    const destinationColumns = [
      "surface_identity", "chat_id", "codex_session_id", "gemini_session_id", "claude_session_id",
      "antigravity_session_id", "active_execution_lock", "last_update_id", "codex_consecutive_failures",
      "claude_consecutive_failures", "antigravity_consecutive_failures", "codex_session_created_at",
      "antigravity_session_created_at", "claude_session_created_at", "kimchi_session_id",
      "kimchi_consecutive_failures", "kimchi_session_created_at", "grok_session_id", "grok_session_created_at",
      "grok_consecutive_failures", "cursor_session_id", "cursor_session_created_at", "cursor_consecutive_failures",
      "interactive_cli_preference",
    ];
    for (const state of stateRows) {
      const identity = String(state.surface_identity);
      const copy: Record<string, unknown> = {
        ...state,
        surface_identity: isolatedIdentity(identity, copyId),
        active_execution_lock: 0,
        codex_consecutive_failures: 0,
        claude_consecutive_failures: 0,
        antigravity_consecutive_failures: 0,
        grok_consecutive_failures: 0,
        cursor_consecutive_failures: 0,
        kimchi_consecutive_failures: 0,
      };
      let hasPostCopySession = false;
      // Gemini's legacy ID was migrated to antigravity; it has no reliable
      // creation timestamp and must never be rebound into an independent copy.
      copy.gemini_session_id = null;
      for (const provider of sessionColumns) {
        const createdAt = state[`${provider}_session_created_at`];
        if (!isAfterCutoff(createdAt, cutoff)) {
          copy[`${provider}_session_id`] = null;
          copy[`${provider}_session_created_at`] = null;
        } else if (state[`${provider}_session_id`]) {
          hasPostCopySession = true;
        }
      }
      const hasPostCutoffActivity = Boolean(
        // arch-lint-allow-legacy-sql: recovery identity migration owns this bounded read.
        db.prepare("SELECT 1 FROM conversation_turns WHERE surface_identity = ? AND created_at >= ? LIMIT 1").get(isolatedIdentity(identity, copyId), cutoff)
        || db.prepare("SELECT 1 FROM bridge_runs WHERE surface_identity = ? AND started_at >= ? LIMIT 1").get(isolatedIdentity(identity, copyId), cutoff)
        || db.prepare("SELECT 1 FROM pending_messages WHERE surface = ? AND created_at >= ? LIMIT 1").get(isolatedIdentity(identity, copyId), cutoff),
      );
      if (!hasPostCopySession && !state.interactive_cli_preference && !state.last_update_id) continue;
      if (!hasPostCutoffActivity) copy.last_update_id = 0;
      for (const provider of sessionColumns) {
        if (copy[`${provider}_session_id`] === null) copy[`${provider}_session_created_at`] = null;
      }
      const placeholders = destinationColumns.map(() => "?").join(", ");
      const sessionUpdates = sessionColumns.flatMap((provider) => [
        `${provider}_session_id = excluded.${provider}_session_id`,
        `${provider}_session_created_at = excluded.${provider}_session_created_at`,
      ]);
      db.prepare(`INSERT INTO bridge_state (${destinationColumns.join(", ")}) VALUES (${placeholders})
        ON CONFLICT(surface_identity, chat_id) DO UPDATE SET
          ${sessionUpdates.join(", ")},
          last_update_id = excluded.last_update_id,
          interactive_cli_preference = COALESCE(excluded.interactive_cli_preference, bridge_state.interactive_cli_preference)`)
        .run(...destinationColumns.map((column) => copy[column] ?? null));
    }

    // Conversation summaries are keyed only by chat, not by surface. The
    // recovered database itself is copy-local, so retain the original key and
    // keep the summary available alongside the re-scoped turn history.

    const continuationRows = db.prepare("SELECT key, value FROM settings WHERE key LIKE ?").all(`${CONTINUATION_PREFIX}%`) as Array<{ key: string; value: string }>;
    let continuationsFenced = 0;
    for (const row of continuationRows) {
      const continuation = parseRecord(row.value);
      if (!continuation || typeof continuation.surfaceIdentity !== "string") continue;
      if (!continuation.surfaceIdentity.startsWith("telegram:")) continue;
      if (!isAfterCutoff(continuation.requestedAt, cutoff)
        && (continuation.state === "pending" || continuation.state === "claimed")) {
        continuation.state = "cancelled";
        continuation.error = "inherited continuation fenced during recovery-copy isolation";
        continuation.completedAt = now;
        continuationsFenced += 1;
      }
      continuation.surfaceIdentity = isolatedIdentity(continuation.surfaceIdentity, copyId);
      db.prepare("UPDATE settings SET value = ? WHERE key = ?").run(JSON.stringify(continuation), row.key);
    }

    let capacityClaimsArchived = 0;
    const capacityTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'execution_capacity_claims'").get();
    if (capacityTable) {
      // Capacity claims are process-owned leases, not durable activity. None
      // can be transferred to a recovered execution, even if acquired post-cutoff.
      const claims = db.prepare("SELECT * FROM execution_capacity_claims").all() as Array<Record<string, unknown>>;
      const archive = db.prepare(`INSERT OR IGNORE INTO recovery_copy_execution_archive (copy_id, record_type, record_key, payload_json, archived_at) VALUES (?, 'execution_capacity_claim', ?, ?, ?)`);
      for (const claim of claims) {
        const key = String(claim.claim_id);
        archive.run(copyId, key, JSON.stringify(claim), now);
        db.prepare("DELETE FROM execution_capacity_claims WHERE claim_id = ?").run(key);
        capacityClaimsArchived += 1;
      }
    }

    const routineRows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'scheduled-routine:v1:%'").all() as Array<{ key: string; value: string }>;
    for (const row of routineRows) {
      const routine = parseRecord(row.value);
      if (!routine || typeof routine.surfaceIdentity !== "string" || !routine.surfaceIdentity.startsWith("telegram:")) continue;
      routine.surfaceIdentity = isolatedIdentity(routine.surfaceIdentity, copyId);
      db.prepare("UPDATE settings SET value = ? WHERE key = ?").run(JSON.stringify(routine), row.key);
    }

    const markerValue = {
      schemaVersion: 1,
      copyId,
      recoveryPointCreatedAt: cutoff,
      surfaceIdentities: surfaces.size,
      runsFenced,
      continuationsFenced,
      capacityClaimsArchived,
      appliedAt: now,
    };
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(markerKey, JSON.stringify(markerValue));
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run("agent_bridge_recovery_copy_active_identity:v1", copyId);
    return markerValue;
  });

  const result = tx();
  return { ...result, alreadyApplied: false };
}

/** Runtime counterpart: isolate newly created Telegram state from source history. */
export function recoveryCopySurfaceIdentity(db: Database.Database, baseIdentity: string): string {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get("agent_bridge_recovery_copy_active_identity:v1") as { value: string } | undefined;
  const copyId = row?.value;
  return copyId && /^ws_[a-zA-Z0-9]+$/.test(copyId) && baseIdentity.startsWith("telegram:")
    ? isolatedIdentity(baseIdentity, copyId)
    : baseIdentity;
}
