/**
 * PURPOSE: Provider-specific validation for successful CLI process exits.
 * INPUTS: Provider kind plus complete stdout/stderr captured by cliSupervisor.
 * OUTPUTS: null for a valid success, or a classified Error that converts the
 * otherwise exit-zero process into a failed run before run.completed emits.
 * NEIGHBORS: src/cliSupervisor.ts, src/providers/codexRuntime.ts, src/claudeStreamJson.ts
 */

import type { CliOptions, CliResult } from "./types.js";
import { hasUsableFinalResponse } from "./providers/codexRuntime.js";
import { inspectClaudeStreamJsonOutput } from "./claudeStreamJson.js";

const CODEX_MISSING_CUSTOM_TOOL_OUTPUT = "Custom tool call output is missing for call id:";
const CLAUDE_BACKGROUND_TASK_CEILING = /^Background tasks still running after \d+(?:ms|s); terminating\.(?: Set CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 to wait indefinitely\.)?$/m;
const CLAUDE_BACKGROUND_TASK_INCOMPLETE = "Claude stopped outstanding background work before completion could be verified";
const CLAUDE_MISSING_TERMINAL_RESULT = "Claude structured output ended before completion could be verified";

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

export function isClaudeUncertainCompletionFailureMessage(message: string): boolean {
  return message === CLAUDE_BACKGROUND_TASK_INCOMPLETE || message === CLAUDE_MISSING_TERMINAL_RESULT;
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

export function validateSuccessfulCliExit(
  bot: CliOptions["bot"],
  output: Readonly<{ stdout: string; stderr: string }>,
): Error | null {
  if (bot === "claude") return validateClaudeSuccessfulExit(output);
  if (bot !== "codex") return null;
  if (!output.stderr.includes(CODEX_MISSING_CUSTOM_TOOL_OUTPUT)) return null;
  if (hasUsableFinalResponse(output.stdout)) return null;
  return new CodexMissingToolOutputError();
}
