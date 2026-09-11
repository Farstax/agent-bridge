/**
 * PURPOSE: Provider-specific validation for successful CLI process exits.
 * INPUTS: Provider kind plus complete stdout/stderr captured by cliSupervisor.
 * OUTPUTS: null for a valid success, or a classified Error that converts the
 * otherwise exit-zero process into a failed run before run.completed emits.
 * NEIGHBORS: src/cliSupervisor.ts and native provider runtimes.
 */

import type { CliOptions } from "./types.js";
import { parseAntigravityStreamJsonResult } from "./providers/antigravityRuntime.js";
import { parseResult as parseGrokResult } from "./providers/grokRuntime.js";
import { parseResult as parseCursorResult } from "./providers/cursorRuntime.js";

const AGY_UNCERTAIN_COMPLETION = "Agy completion could not be verified from structured output";
const GROK_UNCERTAIN_COMPLETION = "Grok completion could not be verified from structured output";
const CURSOR_UNCERTAIN_COMPLETION = "Cursor completion could not be verified from structured output";
const AGY_CONVERSATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class AntigravityUncertainCompletionError extends Error {
  readonly sessionId: string | null;

  constructor(sessionId: string | null) {
    super(AGY_UNCERTAIN_COMPLETION);
    this.name = "AntigravityUncertainCompletionError";
    this.sessionId = sessionId;
  }
}

export class GrokUncertainCompletionError extends Error {
  readonly sessionId: string | null;

  constructor(sessionId: string | null) {
    super(GROK_UNCERTAIN_COMPLETION);
    this.name = "GrokUncertainCompletionError";
    this.sessionId = sessionId;
  }
}

export class CursorUncertainCompletionError extends Error {
  readonly sessionId: string | null;

  constructor(sessionId: string | null) {
    super(CURSOR_UNCERTAIN_COMPLETION);
    this.name = "CursorUncertainCompletionError";
    this.sessionId = sessionId;
  }
}

export function isAntigravityUncertainCompletionFailureMessage(message: string): boolean {
  return message === AGY_UNCERTAIN_COMPLETION;
}

export function isGrokUncertainCompletionFailureMessage(message: string): boolean {
  return message === GROK_UNCERTAIN_COMPLETION;
}

export function isCursorUncertainCompletionFailureMessage(message: string): boolean {
  return message === CURSOR_UNCERTAIN_COMPLETION;
}

function parseObjectLines(stdout: string): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const value = JSON.parse(trimmed) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) break;
      records.push(value as Record<string, unknown>);
    } catch {
      // Only records before the malformed boundary are trustworthy evidence.
      break;
    }
  }
  return records;
}

function extractAgySessionId(stdout: string): string | null {
  for (const record of parseObjectLines(stdout)) {
    if (
      typeof record.conversation_id === "string" &&
      AGY_CONVERSATION_ID_PATTERN.test(record.conversation_id)
    ) {
      return record.conversation_id;
    }
    if (record.result && typeof record.result === "object" && !Array.isArray(record.result)) {
      const id = (record.result as Record<string, unknown>).conversation_id;
      if (typeof id === "string" && AGY_CONVERSATION_ID_PATTERN.test(id)) return id;
    }
  }
  return null;
}

function extractCursorSessionId(stdout: string): string | null {
  for (const record of parseObjectLines(stdout)) {
    if (typeof record.session_id === "string" && record.session_id.trim()) return record.session_id;
  }
  return null;
}

function inspectGrok(stdout: string): {
  sessionId: string | null;
  sawExplicitFailure: boolean;
} {
  let sessionId: string | null = null;
  let sawExplicitFailure = false;
  for (const record of parseObjectLines(stdout)) {
    if (record.type === "error" || record.type === "max_turns_reached") sawExplicitFailure = true;
    if (record.type !== "end") continue;
    if (typeof record.sessionId === "string" && record.sessionId.trim()) sessionId = record.sessionId;
    const reason = typeof record.stopReason === "string"
      ? record.stopReason.trim().replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/-/g, "_").toLowerCase()
      : "";
    if (reason && reason !== "end_turn" && reason !== "success") sawExplicitFailure = true;
  }
  return { sessionId, sawExplicitFailure };
}

function cursorHasExplicitFailure(stdout: string): boolean {
  return parseObjectLines(stdout).some((record) =>
    record.type === "result" && (record.is_error === true || record.subtype === "error")
  );
}

function agyHasExplicitFailure(stdout: string): boolean {
  return parseObjectLines(stdout).some((record) => {
    if (record.event !== "result" || !record.result || typeof record.result !== "object" || Array.isArray(record.result)) {
      return false;
    }
    return (record.result as Record<string, unknown>).status === "ERROR";
  });
}

function validateAgySuccessfulExit(output: Readonly<{ stdout: string; stderr: string }>): Error | null {
  try {
    parseAntigravityStreamJsonResult(output.stdout);
    return null;
  } catch (error) {
    if (agyHasExplicitFailure(output.stdout)) return error instanceof Error ? error : new Error("Agy reported an error");
    return new AntigravityUncertainCompletionError(extractAgySessionId(output.stdout));
  }
}

function validateGrokSuccessfulExit(output: Readonly<{ stdout: string; stderr: string }>): Error | null {
  try {
    parseGrokResult(output.stdout);
    return null;
  } catch (error) {
    const inspection = inspectGrok(output.stdout);
    if (inspection.sawExplicitFailure) {
      return error instanceof Error ? error : new Error("Grok reported an error");
    }
    return new GrokUncertainCompletionError(inspection.sessionId);
  }
}

function validateCursorSuccessfulExit(output: Readonly<{ stdout: string; stderr: string }>): Error | null {
  try {
    parseCursorResult(output.stdout);
    return null;
  } catch (error) {
    if (cursorHasExplicitFailure(output.stdout)) return error instanceof Error ? error : new Error("Cursor reported an error");
    return new CursorUncertainCompletionError(extractCursorSessionId(output.stdout));
  }
}

export function validateSuccessfulCliExit(
  bot: CliOptions["bot"],
  output: Readonly<{ stdout: string; stderr: string }>,
): Error | null {
  if (bot === "antigravity") return validateAgySuccessfulExit(output);
  if (bot === "grok") return validateGrokSuccessfulExit(output);
  if (bot === "cursor") return validateCursorSuccessfulExit(output);
  return null;
}
