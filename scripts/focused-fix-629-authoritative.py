from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"expected block not found in {path}: {old[:120]!r}")
    p.write_text(text.replace(old, new, 1))


def write(path: str, content: str) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content)


write("src/scheduledRunCorrelation.ts", '''import type { BridgeDb } from "./db.js";

export const SCHEDULED_OCCURRENCE_PREFIX = "scheduled-routine-occurrence:v1:";

export interface ScheduledOccurrenceEvidence {
  version: 1;
  claimedAt: string;
  runId: string | null;
}

export interface ParsedScheduledOccurrenceEvidence {
  version: 0 | 1;
  claimedAt: string;
  runId: string | null;
}

export function scheduledOccurrenceKey(id: string, intendedAt: string): string {
  return `${SCHEDULED_OCCURRENCE_PREFIX}${id}:${intendedAt}`;
}

export function encodeScheduledOccurrenceEvidence(claimedAt: string, runId: string | null = null): string {
  return JSON.stringify({ version: 1, claimedAt: new Date(claimedAt).toISOString(), runId } satisfies ScheduledOccurrenceEvidence);
}

export function parseScheduledOccurrenceEvidence(value: unknown): ParsedScheduledOccurrenceEvidence | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const legacyMs = Date.parse(value);
  if (Number.isFinite(legacyMs)) return { version: 0, claimedAt: new Date(legacyMs).toISOString(), runId: null };
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (parsed.version !== 1 || typeof parsed.claimedAt !== "string") return null;
    const claimedMs = Date.parse(parsed.claimedAt);
    if (!Number.isFinite(claimedMs)) return null;
    const runId = parsed.runId == null ? null : String(parsed.runId).trim();
    if (runId !== null && !/^[0-9a-f-]{16,120}$/i.test(runId)) return null;
    return { version: 1, claimedAt: new Date(claimedMs).toISOString(), runId };
  } catch {
    return null;
  }
}

export function linkScheduledOccurrenceRun(db: BridgeDb, key: string, runId: string): boolean {
  if (!key.startsWith(SCHEDULED_OCCURRENCE_PREFIX) || !runId.trim()) return false;
  return db.runInTransaction(() => {
    const row = db.raw.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value?: string } | undefined;
    const evidence = parseScheduledOccurrenceEvidence(row?.value);
    if (!row?.value || !evidence) return false;
    if (evidence.runId && evidence.runId !== runId) return false;
    if (evidence.runId === runId) return true;
    const next = encodeScheduledOccurrenceEvidence(evidence.claimedAt, runId);
    return db.raw.prepare("UPDATE settings SET value = ? WHERE key = ? AND value = ?")
      .run(next, key, row.value).changes === 1;
  });
}
''')

write("src/db/scheduledOccurrenceCorrelationMigration.ts", '''import type Database from "better-sqlite3";

/** Persist the owning scheduled-occurrence key on queued work so correlation survives restart. */
export function applyScheduledOccurrenceCorrelationMigration(db: Database.Database): void {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pending_messages'").get();
  if (!table) return;
  const columns = db.prepare("PRAGMA table_info(pending_messages)").all() as Array<{ name: string }>;
  if (columns.some((column) => column.name === "scheduled_occurrence_key")) return;
  db.exec("ALTER TABLE pending_messages ADD COLUMN scheduled_occurrence_key TEXT");
}
''')

replace_once("src/db/schema.ts",
'import { applyPendingMessageIdentityRepairMigration } from "./pendingMessageIdentityRepairMigration.js";\n',
'import { applyPendingMessageIdentityRepairMigration } from "./pendingMessageIdentityRepairMigration.js";\nimport { applyScheduledOccurrenceCorrelationMigration } from "./scheduledOccurrenceCorrelationMigration.js";\n')
replace_once("src/db/schema.ts", 'export const CURRENT_SCHEMA_VERSION = 14;', 'export const CURRENT_SCHEMA_VERSION = 15;')
replace_once("src/db/schema.ts",
' * Version 14 restores transport-native queued coordinate types without a\n * JavaScript numeric round-trip for databases already upgraded to v13.\n',
' * Version 14 restores transport-native queued coordinate types without a\n * JavaScript numeric round-trip for databases already upgraded to v13.\n * Version 15 persists the scheduled-occurrence identity on queued work so\n * authoritative occurrence -> Run correlation survives queueing and restart.\n')
replace_once("src/db/schema.ts",
'  { version: 14, name: "restore-pending-message-native-types", up: applyPendingMessageIdentityRepairMigration },\n];',
'  { version: 14, name: "restore-pending-message-native-types", up: applyPendingMessageIdentityRepairMigration },\n  { version: 15, name: "persist-scheduled-occurrence-correlation", up: applyScheduledOccurrenceCorrelationMigration },\n];')

replace_once("src/interactiveIngress.ts",
'  mediaGroupId?: string;\n}',
'  mediaGroupId?: string;\n  /** Internal authoritative correlation for a previously claimed scheduled occurrence. */\n  scheduledOccurrenceKey?: string;\n}')

replace_once("src/scheduledRoutines.ts",
'import type { InteractiveTurnInput } from "./interactiveIngress.js";\n',
'import type { InteractiveTurnInput } from "./interactiveIngress.js";\nimport { encodeScheduledOccurrenceEvidence, scheduledOccurrenceKey } from "./scheduledRunCorrelation.js";\n')
replace_once("src/scheduledRoutines.ts",
'export type ScheduledRoutineDispatch = (routine: ScheduledRoutine, intendedAt: string) => Promise<void>;',
'export type ScheduledRoutineDispatch = (routine: ScheduledRoutine, intendedAt: string, occurrenceKey: string) => Promise<void>;')
replace_once("src/scheduledRoutines.ts", 'const OCCURRENCE_PREFIX = "scheduled-routine-occurrence:v1:";\n', '')
replace_once("src/scheduledRoutines.ts",
'function occurrenceKey(id: string, intendedAt: string): string {\n  return `${OCCURRENCE_PREFIX}${id}:${intendedAt}`;\n}\n\n', '')
replace_once("src/scheduledRoutines.ts",
'''export function claimScheduledRoutineOccurrence(db: BridgeDb, id: string, intendedAt: string): boolean {
  const result = db.raw.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)")
    .run(occurrenceKey(id, intendedAt), new Date().toISOString());
  return result.changes === 1;
}
''',
'''export function claimScheduledRoutineOccurrence(db: BridgeDb, id: string, intendedAt: string): boolean {
  const claimedAt = new Date().toISOString();
  const result = db.raw.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)")
    .run(scheduledOccurrenceKey(id, intendedAt), encodeScheduledOccurrenceEvidence(claimedAt));
  return result.changes === 1;
}
''')
replace_once("src/scheduledRoutines.ts",
'''): boolean {
  return db.runInTransaction(() => {
    const row = db.raw.prepare("SELECT value FROM settings WHERE key = ?").get(routineKey(routine.id)) as { value: string } | undefined;
    const current = row ? parseRoutine(row.value) : null;
    if (!current || !current.enabled) return false;
    if (current.surfaceIdentity !== routine.surfaceIdentity || current.chatKey !== routine.chatKey || current.ownerKey !== routine.ownerKey) return false;
    if (!claimScheduledRoutineOccurrence(db, routine.id, intendedAt)) return false;
    if (current.schedule.type === "once") replaceRoutine(db, { ...current, enabled: false });
    return true;
  });
}
''',
'''): string | null {
  return db.runInTransaction(() => {
    const row = db.raw.prepare("SELECT value FROM settings WHERE key = ?").get(routineKey(routine.id)) as { value: string } | undefined;
    const current = row ? parseRoutine(row.value) : null;
    if (!current || !current.enabled) return null;
    if (current.surfaceIdentity !== routine.surfaceIdentity || current.chatKey !== routine.chatKey || current.ownerKey !== routine.ownerKey) return null;
    if (!claimScheduledRoutineOccurrence(db, routine.id, intendedAt)) return null;
    if (current.schedule.type === "once") replaceRoutine(db, { ...current, enabled: false });
    return scheduledOccurrenceKey(routine.id, intendedAt);
  });
}
''')
replace_once("src/scheduledRoutines.ts",
'''    if (!claimScheduledRoutineForDispatch(db, routine, occurrence.intendedAt)) continue;
    if (occurrence.stale) continue;
    await dispatch(routine, occurrence.intendedAt);
''',
'''    const occurrenceKey = claimScheduledRoutineForDispatch(db, routine, occurrence.intendedAt);
    if (!occurrenceKey) continue;
    if (occurrence.stale) continue;
    await dispatch(routine, occurrence.intendedAt, occurrenceKey);
''')
replace_once("src/scheduledRoutines.ts",
'''  intendedAt: string,
  authorizedUserId: string,
): InteractiveTurnInput {
''',
'''  intendedAt: string,
  authorizedUserId: string,
  claimedOccurrenceKey = scheduledOccurrenceKey(routine.id, intendedAt),
): InteractiveTurnInput {
''')
replace_once("src/scheduledRoutines.ts",
'''      messageId,
      text,
''',
'''      messageId,
      text,
      scheduledOccurrenceKey: claimedOccurrenceKey,
''')
replace_once("src/scheduledRoutines.ts",
'    return { surfaceIdentity: routine.surfaceIdentity, chatKey: routine.chatKey, actorId: authorizedUserId, messageId, text, delivery: { chatId: routine.chatKey, chatType: "private" }, attachments: [] };',
'    return { surfaceIdentity: routine.surfaceIdentity, chatKey: routine.chatKey, actorId: authorizedUserId, messageId, text, scheduledOccurrenceKey: claimedOccurrenceKey, delivery: { chatId: routine.chatKey, chatType: "private" }, attachments: [] };')

# Queue persistence: add one nullable scheduled_occurrence_key field without changing transport identity affinity.
replace_once("src/db.ts",
'    msg: { prompt: string; chatId: number | string; threadId?: number | string; chatType: string; userId?: number | string; attachments?: string[] },\n',
'    msg: { prompt: string; chatId: number | string; threadId?: number | string; chatType: string; userId?: number | string; attachments?: string[]; scheduledOccurrenceKey?: string },\n')
replace_once("src/db.ts",
'''        `INSERT INTO pending_messages (surface, chat_key, prompt, chat_id, thread_id, chat_type, user_id, attachments_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(surface, chatKey, msg.prompt, msg.chatId, msg.threadId ?? null, msg.chatType, msg.userId ?? null, JSON.stringify(msg.attachments ?? []));
''',
'''        `INSERT INTO pending_messages (surface, chat_key, prompt, chat_id, thread_id, chat_type, user_id, attachments_json, scheduled_occurrence_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(surface, chatKey, msg.prompt, msg.chatId, msg.threadId ?? null, msg.chatType, msg.userId ?? null, JSON.stringify(msg.attachments ?? []), msg.scheduledOccurrenceKey ?? null);
''')
replace_once("src/db.ts",
'    id: number; prompt: string; chatId: number | string; threadId: number | string | null; chatType: string; userId: number | string | null; attachments: string[];\n  }> {\n',
'    id: number; prompt: string; chatId: number | string; threadId: number | string | null; chatType: string; userId: number | string | null; attachments: string[]; scheduledOccurrenceKey: string | null;\n  }> {\n')
replace_once("src/db.ts",
'''      .prepare(`SELECT id, prompt, chat_id AS chatId, thread_id AS threadId, chat_type AS chatType, user_id AS userId,
                       attachments_json AS attachmentsJson
''',
'''      .prepare(`SELECT id, prompt, chat_id AS chatId, thread_id AS threadId, chat_type AS chatType, user_id AS userId,
                       attachments_json AS attachmentsJson, scheduled_occurrence_key AS scheduledOccurrenceKey
''')
replace_once("src/db.ts",
'    id: number; chatKey: string; prompt: string; chatId: number | string; threadId: number | string | null; chatType: string; userId: number | string | null; attachments: string[];\n  } | null {\n',
'    id: number; chatKey: string; prompt: string; chatId: number | string; threadId: number | string | null; chatType: string; userId: number | string | null; attachments: string[]; scheduledOccurrenceKey: string | null;\n  } | null {\n')
replace_once("src/db.ts",
'''        SELECT id, chat_key AS chatKey, prompt, chat_id AS chatId, thread_id AS threadId, chat_type AS chatType, user_id AS userId,
               state, claim_run_id AS claimRunId, claim_acquisition_id AS claimAcquisitionId, attachments_json AS attachmentsJson
''',
'''        SELECT id, chat_key AS chatKey, prompt, chat_id AS chatId, thread_id AS threadId, chat_type AS chatType, user_id AS userId,
               state, claim_run_id AS claimRunId, claim_acquisition_id AS claimAcquisitionId, attachments_json AS attachmentsJson,
               scheduled_occurrence_key AS scheduledOccurrenceKey
''')
replace_once("src/db.ts",
'    id: number; chatKey: string; prompt: string; chatId: number | string; threadId: number | string | null; chatType: string; userId: number | string | null; attachments: string[];\n  }> {\n',
'    id: number; chatKey: string; prompt: string; chatId: number | string; threadId: number | string | null; chatType: string; userId: number | string | null; attachments: string[]; scheduledOccurrenceKey: string | null;\n  }> {\n')
# Second SELECT occurrence is inside claimPendingMsgs after claimNext was replaced.
replace_once("src/db.ts",
'''        SELECT id, chat_key AS chatKey, prompt, chat_id AS chatId, thread_id AS threadId, chat_type AS chatType, user_id AS userId,
               state, claim_run_id AS claimRunId, claim_acquisition_id AS claimAcquisitionId, attachments_json AS attachmentsJson
''',
'''        SELECT id, chat_key AS chatKey, prompt, chat_id AS chatId, thread_id AS threadId, chat_type AS chatType, user_id AS userId,
               state, claim_run_id AS claimRunId, claim_acquisition_id AS claimAcquisitionId, attachments_json AS attachmentsJson,
               scheduled_occurrence_key AS scheduledOccurrenceKey
''')
# admitMessage has the same message shape as enqueueMsg; replace its remaining occurrence.
replace_once("src/db.ts",
'    msg: { prompt: string; chatId: number | string; threadId?: number | string; chatType: string; userId?: number | string; attachments?: string[] },\n    maxDepth: number,\n',
'    msg: { prompt: string; chatId: number | string; threadId?: number | string; chatType: string; userId?: number | string; attachments?: string[]; scheduledOccurrenceKey?: string },\n    maxDepth: number,\n')

replace_once("src/engine.ts",
'import { DEFAULT_CONTEXT_MAX_CHARS } from "./db.js";\n',
'import { DEFAULT_CONTEXT_MAX_CHARS } from "./db.js";\nimport { linkScheduledOccurrenceRun } from "./scheduledRunCorrelation.js";\n')
replace_once("src/engine.ts",
'  id: number; chatKey: string; prompt: string; chatId: number | string; threadId: number | string | null; chatType: string; userId: number | string | null; attachments: string[];\n',
'  id: number; chatKey: string; prompt: string; chatId: number | string; threadId: number | string | null; chatType: string; userId: number | string | null; attachments: string[]; scheduledOccurrenceKey: string | null;\n  scheduledOccurrenceKeys?: string[];\n')
replace_once("src/engine.ts",
'''    const chatId = primaryMessage.delivery.chatId;
    const userId = primaryMessage.actorId;
    const chatKey = primaryMessage.chatKey;
''',
'''    const chatId = primaryMessage.delivery.chatId;
    const userId = primaryMessage.actorId;
    const chatKey = primaryMessage.chatKey;
    const scheduledOccurrenceKeys = [...new Set(messages.map((message) => message.scheduledOccurrenceKey).filter((key): key is string => Boolean(key)))];
    if (scheduledOccurrenceKeys.length > 1) throw new Error("interactive group crossed scheduled occurrence boundary");
''')
replace_once("src/engine.ts",
'      executionOutcome = await this._executeAndSend(prompt!, chatId, chatKey, primaryMessage.delivery.chatType, threadId, userId, hookCtx, attachments, attachmentLocalPath, null, true, true, !finalDeliveryActive, ownsAugmentedTask);',
'      executionOutcome = await this._executeAndSend(prompt!, chatId, chatKey, primaryMessage.delivery.chatType, threadId, userId, hookCtx, attachments, attachmentLocalPath, null, true, true, !finalDeliveryActive, ownsAugmentedTask, true, [], scheduledOccurrenceKeys);')
replace_once("src/engine.ts",
'''    notifyCapacityFailure = true,
    claimedPendingIds: number[] = [],
  ): Promise<ExecutionOutcome> {
''',
'''    notifyCapacityFailure = true,
    claimedPendingIds: number[] = [],
    scheduledOccurrenceKeys: string[] = [],
  ): Promise<ExecutionOutcome> {
''')
replace_once("src/engine.ts",
'''      const admission = this.db.admitMessage(this.surfaceIdentity, chatKey, {
        prompt, chatId, threadId, chatType, userId, attachments,
      }, MAX_QUEUE_DEPTH, honorBusyMode && !ownsActiveTask && this.laneCoordinator.hasAugmentedTask(this._executionLane(chatKey)));
''',
'''      const admission = this.db.admitMessage(this.surfaceIdentity, chatKey, {
        prompt, chatId, threadId, chatType, userId, attachments,
        scheduledOccurrenceKey: scheduledOccurrenceKeys[0],
      }, MAX_QUEUE_DEPTH, honorBusyMode && !ownsActiveTask && this.laneCoordinator.hasAugmentedTask(this._executionLane(chatKey)));
''')
replace_once("src/engine.ts",
'      this.db.enqueueMsg(this.surfaceIdentity, chatKey, { prompt, chatId, threadId, chatType, userId, attachments });',
'      this.db.enqueueMsg(this.surfaceIdentity, chatKey, { prompt, chatId, threadId, chatType, userId, attachments, scheduledOccurrenceKey: scheduledOccurrenceKeys[0] });')
replace_once("src/engine.ts",
'''      const { runId, eventContext, collect, finalize } = this._createEventContext(chatId, chatKey, threadId, laneHandle);
      const result = await this._executeAndDeliverTurn({
''',
'''      const { runId, eventContext, collect, finalize } = this._createEventContext(chatId, chatKey, threadId, laneHandle);
      for (const occurrenceKey of scheduledOccurrenceKeys) {
        if (!linkScheduledOccurrenceRun(this.db, occurrenceKey, runId)) {
          throw new Error(`scheduled occurrence correlation unavailable: ${occurrenceKey}`);
        }
      }
      const result = await this._executeAndDeliverTurn({
''')
replace_once("src/engine.ts",
'''      } : {
        ...claimed[0],
        prompt: [...(augmentation ? [augmentation.prompt] : []), ...claimed.map((row) => row.prompt)].join("\\n\\n"),
        attachments: [...(augmentation?.attachments ?? []), ...claimed.flatMap((row) => row.attachments)],
        pendingIds: claimed.map((row) => row.id),
        queueRecoveryAttempt: recoveryAttempt,
      };
''',
'''      } : {
        ...claimed[0],
        prompt: [...(augmentation ? [augmentation.prompt] : []), ...claimed.map((row) => row.prompt)].join("\\n\\n"),
        attachments: [...(augmentation?.attachments ?? []), ...claimed.flatMap((row) => row.attachments)],
        pendingIds: claimed.map((row) => row.id),
        scheduledOccurrenceKeys: [...new Set(claimed.map((row) => row.scheduledOccurrenceKey).filter((key): key is string => Boolean(key)))],
        queueRecoveryAttempt: recoveryAttempt,
      };
''')
replace_once("src/engine.ts",
'''      next.queueRecoveryAttempt == null || next.queueRecoveryAttempt >= MAX_QUEUE_RECOVERY_ATTEMPTS,
      next.pendingIds ?? [next.id],
    );
''',
'''      next.queueRecoveryAttempt == null || next.queueRecoveryAttempt >= MAX_QUEUE_RECOVERY_ATTEMPTS,
      next.pendingIds ?? [next.id],
      next.scheduledOccurrenceKeys ?? (next.scheduledOccurrenceKey ? [next.scheduledOccurrenceKey] : []),
    );
''')

replace_once("src/index-interactive.ts", '  async (routine, intendedAt) => {', '  async (routine, intendedAt, occurrenceKey) => {')
replace_once("src/index-interactive.ts", '    const turn = buildScheduledInteractiveTurn(routine, intendedAt, scheduledActorId);', '    const turn = buildScheduledInteractiveTurn(routine, intendedAt, scheduledActorId, occurrenceKey);')
replace_once("src/index-discord-interactive.ts", '    async (routine, intendedAt) => {', '    async (routine, intendedAt, occurrenceKey) => {')
replace_once("src/index-discord-interactive.ts", '      const turn = buildScheduledInteractiveTurn(routine, intendedAt, scheduledActorId);', '      const turn = buildScheduledInteractiveTurn(routine, intendedAt, scheduledActorId, occurrenceKey);')

replace_once("src/runtimeInspector.ts",
'import { latestDueScheduledOccurrence, type ScheduledRoutine } from "./scheduledRoutines.js";\n',
'import { latestDueScheduledOccurrence, type ScheduledRoutine } from "./scheduledRoutines.js";\nimport { parseScheduledOccurrenceEvidence, SCHEDULED_OCCURRENCE_PREFIX } from "./scheduledRunCorrelation.js";\n')
replace_once("src/runtimeInspector.ts", 'const OCCURRENCE_PREFIX = "scheduled-routine-occurrence:v1:";\n', '')
replace_once("src/runtimeInspector.ts", '    const occurrencePrefix = `${OCCURRENCE_PREFIX}${id}:`;', '    const occurrencePrefix = `${SCHEDULED_OCCURRENCE_PREFIX}${id}:`;')
old_block = '''    const claimedAt = text(occurrence?.value, 60);
    let correlatedRun: Row | null = null;
    let correlationReasonCode: string | null = occurrence ? "run_correlation_unavailable" : null;
    if (claimedAt && hasTable(db, "bridge_runs")) {
      const claimedMs = Date.parse(claimedAt);
      if (Number.isFinite(claimedMs)) {
        const cutoff = new Date(claimedMs + 30_000).toISOString();
        const candidates = db.prepare(`SELECT run_id,status,bot,started_at FROM bridge_runs
          WHERE chat_id=? AND started_at>=? AND started_at<=?
          ORDER BY started_at ASC, rowid ASC LIMIT 2`).all(s.chatKey, claimedAt, cutoff) as Row[];
        if (candidates.length === 1) {
          correlatedRun = candidates[0];
          correlationReasonCode = null;
        } else if (candidates.length > 1) {
          correlationReasonCode = "run_correlation_ambiguous";
        }
      }
    }
'''
new_block = '''    const evidence = parseScheduledOccurrenceEvidence(occurrence?.value);
    const claimedAt = evidence?.claimedAt ?? null;
    let correlatedRun: Row | null = null;
    let correlationReasonCode: string | null = occurrence
      ? evidence
        ? evidence.runId
          ? "linked_run_unavailable"
          : evidence.version === 0 ? "run_correlation_legacy_unavailable" : "run_not_created"
        : "occurrence_evidence_invalid"
      : null;
    if (evidence?.runId && hasTable(db, "bridge_runs")) {
      correlatedRun = db.prepare(`SELECT run_id,status,bot,started_at,ended_at FROM bridge_runs
        WHERE run_id=? AND chat_id=? LIMIT 1`).get(evidence.runId, s.chatKey) as Row | undefined ?? null;
      if (correlatedRun) correlationReasonCode = null;
    }
'''
replace_once("src/runtimeInspector.ts", old_block, new_block)

# Focused regression coverage: authoritative evidence, no timestamp inference, and durable queue identity.
replace_once("test/runtimeInspector.test.ts",
'import { claimScheduledRoutineOccurrence, createScheduledRoutine } from "../src/scheduledRoutines.js";\n',
'import { claimScheduledRoutineOccurrence, createScheduledRoutine } from "../src/scheduledRoutines.js";\nimport { linkScheduledOccurrenceRun, scheduledOccurrenceKey } from "../src/scheduledRunCorrelation.js";\n')
replace_once("test/runtimeInspector.test.ts",
'''      const routineOccurrence = new Date().toISOString();
      expect(claimScheduledRoutineOccurrence(db, "routine-1", routineOccurrence)).toBe(true);
      db.insertRun("run-routine", "chat-1", "codex");
''',
'''      const routineOccurrence = new Date().toISOString();
      expect(claimScheduledRoutineOccurrence(db, "routine-1", routineOccurrence)).toBe(true);
      const occurrenceKey = scheduledOccurrenceKey("routine-1", routineOccurrence);
      expect(linkScheduledOccurrenceRun(db, occurrenceKey, "run-routine")).toBe(true);
      db.insertRun("run-routine", "chat-1", "codex");
''')
# Replace the timestamp-ambiguity regression with a false-positive guard.
start = '  it("fails closed when more than one Run could match a scheduled occurrence", () => {'
end = '  it("uses unknown/unavailable states instead of inventing missing or stale evidence", () => {'
t = Path("test/runtimeInspector.test.ts").read_text()
si = t.find(start)
ei = t.find(end)
if si < 0 or ei < 0 or ei <= si:
    raise SystemExit("runtime inspector ambiguity test block not found")
replacement = '''  it("never infers a scheduled Run from nearby conversation timing", () => {
    const { dir, path, db, healthDb } = fixture();
    try {
      createScheduledRoutine(db, {
        id: "routine-unlinked",
        name: "Unlinked routine",
        instruction: "bounded instruction",
        kind: "companion",
        surfaceIdentity: "telegram:interactive",
        chatKey: "chat-unlinked",
        ownerKey: "owner-1",
        timezone: "UTC",
        schedule: { type: "weekly", weekdays: [1], time: "09:00" },
        enabled: true,
        createdAt: new Date().toISOString(),
      });
      const intendedAt = new Date().toISOString();
      expect(claimScheduledRoutineOccurrence(db, "routine-unlinked", intendedAt)).toBe(true);
      db.insertRun("nearby-user-run", "chat-unlinked", "codex");

      const view = JSON.parse(renderAgentBridgeInspection(["--json"], {
        AGENT_BRIDGE_CONTEXT_DB: path,
        AGENT_BRIDGE_CHAT_KEY: "chat-unlinked",
        AGENT_BRIDGE_SURFACE_IDENTITY: "telegram:interactive",
        AGENT_BRIDGE_OWNER_KEY: "owner-1",
        HOME: dir,
      }));
      expect(view.scheduledRoutines[0].recentOccurrence).toEqual(expect.objectContaining({
        runId: null,
        reasonCode: "run_not_created",
      }));
    } finally {
      db.close();
      healthDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

'''
Path("test/runtimeInspector.test.ts").write_text(t[:si] + replacement + t[ei:])

# Add queue migration/round-trip coverage to scheduled routines test.
replace_once("test/scheduledRoutines.test.ts",
'} from "../src/scheduledRoutines.js";\n',
'} from "../src/scheduledRoutines.js";\nimport { parseScheduledOccurrenceEvidence, scheduledOccurrenceKey } from "../src/scheduledRunCorrelation.js";\n')
marker = '  it("fires a one-shot routine once then disables it, and skips stale one-shots", async () => {'
addition = '''  it("persists the claimed occurrence key through the pending queue", () => {
    const db = setup();
    const intendedAt = "2026-08-31T06:00:00.000Z";
    expect(claimScheduledRoutineOccurrence(db, "routine-1", intendedAt)).toBe(true);
    const key = scheduledOccurrenceKey("routine-1", intendedAt);
    const evidence = parseScheduledOccurrenceEvidence(db.getSetting(key));
    expect(evidence).toEqual(expect.objectContaining({ version: 1, runId: null }));

    db.enqueueMsg("telegram:interactive", "-100:42", {
      prompt: "scheduled prompt",
      chatId: -100,
      threadId: 42,
      chatType: "supergroup",
      userId: 123,
      scheduledOccurrenceKey: key,
    });
    const handle = db.acquireLock("telegram:interactive", "-100:42");
    expect(handle).not.toBeNull();
    const claimed = db.claimNextPendingMsg(handle!);
    expect(claimed?.scheduledOccurrenceKey).toBe(key);
    db.close();
  });

'''
replace_once("test/scheduledRoutines.test.ts", marker, addition + marker)

# Migration-specific test is self-contained and catches role no-op + v14->v15 preservation.
write("test/scheduledOccurrenceCorrelationMigration.test.ts", '''import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { applyMigrationsUpTo } from "../src/db/schema.js";
import { applyScheduledOccurrenceCorrelationMigration } from "../src/db/scheduledOccurrenceCorrelationMigration.js";

describe("scheduled occurrence correlation migration", () => {
  it("adds a nullable correlation key without rewriting queued transport identities", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE pending_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      surface TEXT NOT NULL,
      chat_key TEXT NOT NULL,
      prompt TEXT NOT NULL,
      chat_id BLOB NOT NULL,
      thread_id BLOB,
      chat_type TEXT NOT NULL,
      user_id BLOB,
      state TEXT NOT NULL DEFAULT 'queued',
      claim_run_id TEXT,
      claim_acquisition_id TEXT,
      claimed_at TEXT,
      attachments_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );`);
    const snowflake = "1234567890123456789";
    db.prepare(`INSERT INTO pending_messages
      (surface,chat_key,prompt,chat_id,thread_id,chat_type,user_id,created_at)
      VALUES ('discord:interactive','c','p',?,?, 'private',?, '2026-09-01T00:00:00.000Z')`).run(snowflake, snowflake, snowflake);
    applyScheduledOccurrenceCorrelationMigration(db);
    const columns = db.prepare("PRAGMA table_info(pending_messages)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain("scheduled_occurrence_key");
    const row = db.prepare("SELECT typeof(chat_id) AS type, chat_id, scheduled_occurrence_key FROM pending_messages").get() as any;
    expect(row).toEqual({ type: "text", chat_id: snowflake, scheduled_occurrence_key: null });
    db.close();
  });

  it("is a no-op for role databases without pending_messages", () => {
    const db = new Database(":memory:");
    expect(() => applyScheduledOccurrenceCorrelationMigration(db)).not.toThrow();
    db.close();
  });
});
''')
