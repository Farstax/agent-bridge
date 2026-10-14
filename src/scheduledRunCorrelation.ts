import type { BridgeDb } from "./db.js";

export const SCHEDULED_OCCURRENCE_PREFIX = "scheduled-routine-occurrence:v1:";
export type ScheduledOccurrenceKind = "scheduled" | "manual";

export interface ScheduledOccurrenceEvidence {
  version: 1;
  claimedAt: string;
  runId: string | null;
  status?: "claimed" | "running" | "completed" | "failed" | "fenced";
  error?: string;
}

export interface ParsedScheduledOccurrenceEvidence {
  version: 0 | 1;
  claimedAt: string;
  runId: string | null;
  status?: "claimed" | "running" | "completed" | "failed" | "fenced";
  error?: string;
}

export function scheduledOccurrenceKey(
  id: string,
  intendedAt: string,
  kind: ScheduledOccurrenceKind = "scheduled",
): string {
  return kind === "scheduled"
    ? `${SCHEDULED_OCCURRENCE_PREFIX}${id}:${intendedAt}`
    : `${SCHEDULED_OCCURRENCE_PREFIX}${id}:${kind}:${intendedAt}`;
}

export function encodeScheduledOccurrenceEvidence(
  claimedAt: string,
  runId: string | null = null,
  status?: "claimed" | "running" | "completed" | "failed" | "fenced",
  error?: string,
): string {
  return JSON.stringify({
    version: 1,
    claimedAt: new Date(claimedAt).toISOString(),
    runId,
    ...(status ? { status } : {}),
    ...(error ? { error: error.slice(0, 500) } : {}),
  } satisfies ScheduledOccurrenceEvidence);
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
    if (runId !== null && !/^[A-Za-z0-9_.:-]{1,120}$/.test(runId)) return null;
    const status = typeof parsed.status === "string" && ["claimed", "running", "completed", "failed", "fenced"].includes(parsed.status)
      ? (parsed.status as any) : undefined;
    const error = typeof parsed.error === "string" ? parsed.error : undefined;
    return { version: 1, claimedAt: new Date(claimedMs).toISOString(), runId, ...(status ? { status } : {}), ...(error ? { error } : {}) };
  } catch {
    return null;
  }
}

function canReplaceLinkedRun(db: BridgeDb, previousRunId: string): boolean {
  const run = db.getRun(previousRunId) as { status?: string } | undefined;
  if (!run) return true;
  return run.status === "failed" || run.status === "cancelled";
}

export function linkScheduledOccurrenceRun(db: BridgeDb, key: string, runId: string): boolean {
  if (!key.startsWith(SCHEDULED_OCCURRENCE_PREFIX) || !runId.trim()) return false;
  return db.runInTransaction(() => {
    const row = db.raw.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value?: string } | undefined;
    const evidence = parseScheduledOccurrenceEvidence(row?.value);
    if (!row?.value || !evidence) return false;
    if (evidence.runId === runId) return true;
    if (evidence.runId && !canReplaceLinkedRun(db, evidence.runId)) return false;
    const run = db.getRun(runId);
    const status = run?.status === "done" ? "completed" : run?.status === "failed" ? "failed" : run?.status === "cancelled" ? "fenced" : "running";
    const next = encodeScheduledOccurrenceEvidence(evidence.claimedAt, runId, status, run?.error ?? undefined);
    return db.raw.prepare("UPDATE settings SET value = ? WHERE key = ? AND value = ?")
      .run(next, key, row.value).changes === 1;
  });
}

export function markScheduledOccurrenceFailed(db: BridgeDb, key: string, error: string): boolean {
  if (!key.startsWith(SCHEDULED_OCCURRENCE_PREFIX)) return false;
  return db.runInTransaction(() => {
    const row = db.raw.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value?: string } | undefined;
    const evidence = parseScheduledOccurrenceEvidence(row?.value);
    if (!row?.value || !evidence) return false;
    if (evidence.runId) {
      const run = db.getRun(evidence.runId);
      if (run && run.status === "done") return false;
    }
    const next = encodeScheduledOccurrenceEvidence(evidence.claimedAt, evidence.runId, "failed", error);
    return db.raw.prepare("UPDATE settings SET value = ? WHERE key = ? AND value = ?")
      .run(next, key, row.value).changes === 1;
  });
}
