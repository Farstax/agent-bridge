/**
 * PURPOSE: Durable, bounded continuation requests for ordinary interactive Runs.
 * A provider can yield while required external work is still pending and Agent Bridge
 * will admit one later ordinary Run against the same conversation/provider session.
 * This is intentionally not a scheduler or workflow engine.
 */
import type { BridgeDb } from "./db.js";
import type { InteractiveTurnInput } from "./interactiveIngress.js";
import type { RouteableBotKind } from "./types.js";
import { lookupProviderSession } from "./providers/sessionRuntime.js";

const PREFIX = "run-continuation:v1:";
const DEFAULT_SCAN_MS = 5_000;
const MIN_DELAY_SECONDS = 5;
const MAX_DELAY_SECONDS = 30 * 60;
const MAX_LIFETIME_MS = 2 * 60 * 60 * 1_000;
const MAX_REASON_CHARS = 500;

export type RunContinuationState = "pending" | "claimed" | "completed" | "failed" | "expired" | "cancelled";

export interface RunContinuation {
  version: 1;
  id: string;
  originRunId: string;
  surfaceIdentity: string;
  chatKey: string;
  provider: RouteableBotKind;
  reason: string;
  requestedAt: string;
  dueAt: string;
  expiresAt: string;
  state: RunContinuationState;
  claimedAt?: string;
  completedAt?: string;
  error?: string;
}

export interface RequestRunContinuationInput {
  originRunId: string;
  surfaceIdentity: string;
  chatKey: string;
  provider: RouteableBotKind;
  reason: string;
  afterSeconds: number;
}

function key(id: string): string {
  return `${PREFIX}${id}`;
}

function bounded(value: string, label: string, max: number): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  if (normalized.length > max) throw new Error(`${label} exceeds ${max} characters`);
  return normalized;
}

function parse(value: string): RunContinuation | null {
  try {
    const candidate = JSON.parse(value) as RunContinuation;
    if (
      candidate?.version !== 1
      || !candidate.id
      || !candidate.originRunId
      || !candidate.surfaceIdentity
      || !candidate.chatKey
      || !candidate.provider
      || !candidate.reason
      || !["pending", "claimed", "completed", "failed", "expired", "cancelled"].includes(candidate.state)
    ) return null;
    return candidate;
  } catch {
    return null;
  }
}

export function requestRunContinuation(
  db: BridgeDb,
  input: RequestRunContinuationInput,
  nowMs = Date.now(),
): RunContinuation {
  if (!Number.isInteger(input.afterSeconds) || input.afterSeconds < MIN_DELAY_SECONDS || input.afterSeconds > MAX_DELAY_SECONDS) {
    throw new Error(`after-seconds must be an integer between ${MIN_DELAY_SECONDS} and ${MAX_DELAY_SECONDS}`);
  }
  const originRunId = bounded(input.originRunId, "origin run id", 200);
  const surfaceIdentity = bounded(input.surfaceIdentity, "surface identity", 160);
  const chatKey = bounded(input.chatKey, "chat key", 200);
  const reason = bounded(input.reason, "reason", MAX_REASON_CHARS);
  const provider = bounded(String(input.provider), "provider", 80) as RouteableBotKind;
  const requestedAt = new Date(nowMs).toISOString();
  const dueAt = new Date(nowMs + input.afterSeconds * 1_000).toISOString();
  const expiresAt = new Date(nowMs + MAX_LIFETIME_MS).toISOString();
  const id = originRunId;
  const originRun = db.getRun(originRunId);
  if (originRun) {
    if (originRun.status !== "running") throw new Error("originating Run is no longer active");
    if (originRun.chat_id !== chatKey) throw new Error("originating Run conversation mismatch");
    if (originRun.bot !== provider) throw new Error("originating Run provider mismatch");
  }

  return db.runInTransaction(() => {
    const existingRow = db.raw.prepare("SELECT value FROM settings WHERE key = ?").get(key(id)) as { value: string } | undefined;
    const existing = existingRow ? parse(existingRow.value) : null;
    if (existing?.state === "claimed") throw new Error("continuation already claimed for this Run");
    const continuation: RunContinuation = {
      version: 1,
      id,
      originRunId,
      surfaceIdentity,
      chatKey,
      provider,
      reason,
      requestedAt,
      dueAt,
      expiresAt,
      state: "pending",
    };
    db.raw.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key(id), JSON.stringify(continuation));
    return continuation;
  });
}

export function listRunContinuations(db: BridgeDb, surfaceIdentity?: string): RunContinuation[] {
  const rows = db.raw.prepare("SELECT value FROM settings WHERE key LIKE ? ORDER BY key ASC")
    .all(`${PREFIX}%`) as Array<{ value: string }>;
  return rows
    .map((row) => parse(row.value))
    .filter((item): item is RunContinuation => !!item)
    .filter((item) => surfaceIdentity === undefined || item.surfaceIdentity === surfaceIdentity);
}

export function claimDueRunContinuation(
  db: BridgeDb,
  id: string,
  nowMs = Date.now(),
): RunContinuation | null {
  return db.runInTransaction(() => {
    const row = db.raw.prepare("SELECT value FROM settings WHERE key = ?").get(key(id)) as { value: string } | undefined;
    const current = row ? parse(row.value) : null;
    if (!current || current.state !== "pending") return null;
    if (Date.parse(current.expiresAt) <= nowMs) {
      const expired = { ...current, state: "expired" as const };
      db.raw.prepare("UPDATE settings SET value = ? WHERE key = ?").run(JSON.stringify(expired), key(id));
      return null;
    }
    const originRun = db.getRun(current.originRunId);
    if (!originRun || originRun.status === "running") return null;
    const boundSessionId = lookupProviderSession(db, current.chatKey, current.provider);
    if (
      originRun.status !== "done"
      || originRun.chat_id !== current.chatKey
      || originRun.bot !== current.provider
      || !originRun.session_id
      || boundSessionId !== originRun.session_id
    ) {
      const cancelled: RunContinuation = {
        ...current,
        state: "cancelled",
        completedAt: new Date(nowMs).toISOString(),
        error: originRun.status !== "done"
          ? `originating Run ended with status ${originRun.status}`
          : originRun.chat_id !== current.chatKey
            ? "originating Run conversation changed"
            : originRun.bot !== current.provider
              ? "originating Run provider changed"
              : !originRun.session_id
                ? "originating Run has no resumable provider session"
                : "originating provider session binding changed",
      };
      db.raw.prepare("UPDATE settings SET value = ? WHERE key = ?").run(JSON.stringify(cancelled), key(id));
      return null;
    }
    if (Date.parse(current.dueAt) > nowMs) return null;
    const claimed = { ...current, state: "claimed" as const, claimedAt: new Date(nowMs).toISOString() };
    db.raw.prepare("UPDATE settings SET value = ? WHERE key = ?").run(JSON.stringify(claimed), key(id));
    return claimed;
  });
}

export function cancelPendingRunContinuation(
  db: BridgeDb,
  id: string,
  reason: string,
  nowMs = Date.now(),
): boolean {
  return db.runInTransaction(() => {
    const row = db.raw.prepare("SELECT value FROM settings WHERE key = ?").get(key(id)) as { value: string } | undefined;
    const current = row ? parse(row.value) : null;
    if (!current || current.state !== "pending") return false;
    const cancelled: RunContinuation = {
      ...current,
      state: "cancelled",
      completedAt: new Date(nowMs).toISOString(),
      error: reason.slice(0, 500),
    };
    db.raw.prepare("UPDATE settings SET value = ? WHERE key = ?").run(JSON.stringify(cancelled), key(id));
    return true;
  });
}

export function settleRunContinuation(
  db: BridgeDb,
  id: string,
  outcome: "completed" | "failed",
  error?: string,
  nowMs = Date.now(),
): void {
  db.runInTransaction(() => {
    const row = db.raw.prepare("SELECT value FROM settings WHERE key = ?").get(key(id)) as { value: string } | undefined;
    const current = row ? parse(row.value) : null;
    if (!current || current.state !== "claimed") return;
    const settled: RunContinuation = {
      ...current,
      state: outcome,
      completedAt: new Date(nowMs).toISOString(),
      ...(outcome === "failed" && error ? { error: error.slice(0, 500) } : {}),
    };
    db.raw.prepare("UPDATE settings SET value = ? WHERE key = ?").run(JSON.stringify(settled), key(id));
  });
}

export async function scanRunContinuations(
  db: BridgeDb,
  surfaceIdentity: string,
  dispatch: (continuation: RunContinuation) => Promise<void>,
  nowMs = Date.now(),
): Promise<void> {
  for (const candidate of listRunContinuations(db, surfaceIdentity)) {
    if (candidate.state !== "pending") continue;
    const claimed = claimDueRunContinuation(db, candidate.id, nowMs);
    if (!claimed) continue;
    try {
      await dispatch(claimed);
      settleRunContinuation(db, claimed.id, "completed");
    } catch (error) {
      settleRunContinuation(db, claimed.id, "failed", error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
}

export class RunContinuationRunner {
  private timer: NodeJS.Timeout | null = null;
  private scanning = false;

  constructor(
    private readonly db: BridgeDb,
    private readonly surfaceIdentity: string,
    private readonly dispatch: (continuation: RunContinuation) => Promise<void>,
    private readonly scanMs = DEFAULT_SCAN_MS,
  ) {}

  start(): void {
    if (this.timer) return;
    const tick = () => {
      if (this.scanning) return;
      this.scanning = true;
      void scanRunContinuations(this.db, this.surfaceIdentity, this.dispatch)
        .catch((error) => console.error("[run-continuation] scan failed", error))
        .finally(() => { this.scanning = false; });
    };
    tick();
    this.timer = setInterval(tick, this.scanMs);
    this.timer.unref();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}

export function buildTelegramRunContinuationTurn(
  continuation: RunContinuation,
  actorId: string,
): InteractiveTurnInput {
  const match = /^(-?\d+)(?::(\d+))?$/.exec(continuation.chatKey);
  if (!match) throw new Error("run continuation has invalid Telegram chat key");
  const chatId = Number(match[1]);
  const threadId = match[2] === undefined ? undefined : Number(match[2]);
  if (!Number.isSafeInteger(chatId) || (threadId !== undefined && !Number.isSafeInteger(threadId))) {
    throw new Error("run continuation has unsafe Telegram chat key");
  }
  return {
    surfaceIdentity: continuation.surfaceIdentity,
    chatKey: continuation.chatKey,
    actorId,
    messageId: `continuation:${continuation.id}`,
    text: [
      "[Agent Bridge continuation]",
      "A required bounded operation was still pending in the previous Run.",
      "Re-check current external state and continue the original objective from where you left off.",
      "Do not repeat completed side effects. If the operation is still pending and keeping this Run open is impractical, request another bounded continuation.",
      `Pending reason: ${continuation.reason}`,
    ].join("\n"),
    ...(threadId === undefined ? {} : { threadId: String(threadId) }),
    delivery: {
      chatId,
      chatType: chatId < 0 ? "supergroup" : "private",
    },
    attachments: [],
  };
}

export function buildDiscordRunContinuationTurn(
  continuation: RunContinuation,
  actorId: string,
): InteractiveTurnInput {
  if (!continuation.chatKey.trim()) throw new Error("run continuation has invalid Discord chat key");
  return {
    surfaceIdentity: continuation.surfaceIdentity,
    chatKey: continuation.chatKey,
    actorId,
    messageId: `continuation:${continuation.id}`,
    text: [
      "[Agent Bridge continuation]",
      "A required bounded operation was still pending in the previous Run.",
      "Re-check current external state and continue the original objective from where you left off.",
      "Do not repeat completed side effects. If the operation is still pending and keeping this Run open is impractical, request another bounded continuation.",
      `Pending reason: ${continuation.reason}`,
    ].join("\n"),
    delivery: {
      chatId: continuation.chatKey,
      chatType: "private",
    },
    surroundingContext: [],
    attachments: [],
  };
}

