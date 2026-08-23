/**
 * PURPOSE: Own the temporary issue #477 rollback/canary gate for legacy
 * compact summaries and project memory.
 * NEIGHBORS: src/contextPolicy.ts, src/compactConversation.ts,
 * src/repositories/conversationRepository.ts, src/projectMemory.ts
 */

export const LEGACY_MEMORY_COMPACTION_FLAG = "BRIDGE_LEGACY_MEMORY_COMPACTION_ENABLED";
export const TURN_HISTORY_CONTEXT_MAX_CHARS = 24_000;
export const LEGACY_MEMORY_COMPACTION_DISABLED_MESSAGE =
  "Legacy memory and compaction are disabled unless BRIDGE_LEGACY_MEMORY_COMPACTION_ENABLED=true.";

/**
 * Turn-history continuity is the default. Legacy generated summaries and
 * project-memory participation return only when the operator explicitly sets
 * the rollback flag to true. Read live so rollback does not require a
 * process-level module reload in tests and follows existing env policy-reader
 * behavior.
 */
export function legacyMemoryCompactionEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[LEGACY_MEMORY_COMPACTION_FLAG]?.trim().toLowerCase() === "true";
}
