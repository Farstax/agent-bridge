/**
 * PURPOSE: Provider-specific validation for successful CLI process exits.
 * INPUTS: Provider kind plus complete stdout/stderr captured by cliSupervisor.
 * OUTPUTS: null for a valid success, or a classified Error that converts the
 * otherwise exit-zero process into a failed run before run.completed emits.
 * NEIGHBORS: src/cliSupervisor.ts, provider runtimes, src/claudeStreamJson.ts
 */

import type { CliOptions, CliResult } from "./types.js";
import {
  CodexUncertainCompletionError,
  hasUsableFinalResponse,
  parseResult as parseCodexResult,
} from "./providers/codexRuntime.js";
import { parseAntigravityStreamJsonResult } from "./providers/antigravityRuntime.js";
import { parseResult as parseGrokResult } from "./providers/grokRuntime.js";
import { parseResult as parseCursorResult } from "./providers/cursorRuntime.js";
import { inspectClaudeStreamJsonOutput } from "./claudeStreamJson.js";

const CODEX_MISSING_CUSTOM_TOOL_OUTPUT = "Custom tool call output is missing for call id:";
const CLAUDE_BACKGROUND_TASK_CEILING = /^Background tasks still running after \d+(?:ms|s); terminating\.(?: Set CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 to wait indefinitely\.)?$/m;
const CLAUDE_BACKGROUND_TASK_INCOMPLETE = "Claude stopped outstanding background work before completion could be verified";
const CLAUDE_MISSING_TERMINAL_RESULT = "Claude structured output ended before completion could be verified";
const AGY_UNCERTAIN_COMPLETION = "Agy completion could not be verified from structured output";
const GROK_UNCERTAIN_COMPLETION = "Grok completion could not be verified from structured output";
const CURSOR_UNCERTAIN_COMPLETION = "Cursor completion could not be verified from structured output";

export class CodexMissingToolOutputError extends Error {
  constructor() {
    super("Codex custom tool call output is missing and no usable final response was produced");
    this.name = "CodexMissingToolOutputError";
  }
}

export type ClaudeUncertainCompletionReason = "background-task-ceiling" | "missing-terminal-result";

export class ClaudeUncertainCompletionError extends Error {
  readonly reason: ClaudeUncertainCompletionReason;
  readonly sessionId: string | null;
  readonly safeResult: CliResult | null;

  constructor(
    reason: ClaudeUncertainCompletionReason,
    sessionId: string | null,
    safeResult: CliResult | null,
  ) {
    super(reason === "background-task-ceiling"
      ? CLAUDE_BACKGROUND_TASK_INCOMPLETE
      : CLAUDE_MISSING_TERMINAL_RESULT);
    this.name = "ClaudeUncertainCompletionError";
    this.reason = reason;
    this.sessionId = sessionId;
    this.safeResult = safeResult;
  }
}

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

export function isClaudeUncertainCompletionFailureMessage(message: string): boolean {
  return message === CLAUDE_BACKGROUND_TASK_INCOMPLETE || message === CLAUDE_MISSING_TERMINAL_RESULT;
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
      if (value && typeof value === "object" && !Array.isArray(value)) {
        records.push(value as Record<string, unknown>);
      }
    } catch {
      // Classification helpers use only trustworthy records parsed before a
      // malformed boundary. They never treat raw fragments as user output.
    }
  }
  return records;
}

function extractAgySessionId(stdout: string): string | null {
  for (const record of parseObjectLines(stdout)) {
    if (typeof record.conversation_id === "string" && record.conversation_id.trim()) {
      return record.conversation_id;
    }
    if (record.result && typeof record.result === "object" && !Array.isArray(record.result)) {
      const id = (record.result as Record<string, unknown>).conversation_id;
      if (typeof id === "string" && id.trim()) return id;
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

function validateClaudeSuccessfulExit(output: Readonly<{ stdout: string; stderr: string }>): Error | null {
  const inspection = inspectClaudeStreamJsonOutput(output.stdout);
  if (CLAUDE_BACKGROUND_TASK_CEILING.test(output.stderr)) {
    return new ClaudeUncertainCompletionError(
      "background-task-ceiling",
      inspection.result?.sessionId ?? inspection.sessionId,
      inspection.result,
    );
  }
  if (inspection.structured && !inspection.result) {
    return new ClaudeUncertainCompletionError(
      "missing-terminal-result",
      inspection.sessionId,
      null,
    );
  }
  return null;
}

function validateCodexSuccessfulExit(output: Readonly<{ stdout: string; stderr: string }>): Error | null {
  if (output.stderr.includes(CODEX_MISSING_CUSTOM_TOOL_OUTPUT) && !hasUsableFinalResponse(output.stdout)) {
    return new CodexMissingToolOutputError();
  }
  try {
    parseCodexResult(output.stdout);
    return null;
  } catch (error) {
    return error instanceof CodexUncertainCompletionError
      ? error
      : new CodexUncertainCompletionError(null);
  }
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
  if (bot === "claude") return validateClaudeSuccessfulExit(output);
  if (bot === "codex") return validateCodexSuccessfulExit(output);
  if (bot === "antigravity") return validateAgySuccessfulExit(output);
  if (bot === "grok") return validateGrokSuccessfulExit(output);
  if (bot === "cursor") return validateCursorSuccessfulExit(output);
  return null;
}
