/**
 * PURPOSE: Provider-specific validation for successful CLI process exits.
 * INPUTS: Provider kind plus complete stdout/stderr captured by cliSupervisor.
 * OUTPUTS: null for a valid success, or a classified Error that converts the
 * otherwise exit-zero process into a failed run before run.completed emits.
 * NEIGHBORS: src/cliSupervisor.ts and native provider runtimes.
 */

import type { CliOptions } from "./types.js";
import { parseResult as parseCursorResult } from "./providers/cursorRuntime.js";

const CURSOR_UNCERTAIN_COMPLETION = "Cursor completion could not be verified from structured output";

export class CursorUncertainCompletionError extends Error {
  readonly sessionId: string | null;

  constructor(sessionId: string | null) {
    super(CURSOR_UNCERTAIN_COMPLETION);
    this.name = "CursorUncertainCompletionError";
    this.sessionId = sessionId;
  }
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

function extractCursorSessionId(stdout: string): string | null {
  for (const record of parseObjectLines(stdout)) {
    if (typeof record.session_id === "string" && record.session_id.trim()) return record.session_id;
  }
  return null;
}

function cursorHasExplicitFailure(stdout: string): boolean {
  return parseObjectLines(stdout).some((record) =>
    record.type === "result" && (record.is_error === true || record.subtype === "error")
  );
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
  if (bot === "cursor") return validateCursorSuccessfulExit(output);
  return null;
}
