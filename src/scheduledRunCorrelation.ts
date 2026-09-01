import type { BridgeDb } from "./db.js";

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
    if (runId !== null && !/^[A-Za-z0-9_.:-]{1,120}$/.test(runId)) return null;
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
