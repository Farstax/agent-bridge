/**
 * PURPOSE: Provider-specific validation for successful CLI process exits.
 * INPUTS: Provider kind plus complete stdout/stderr captured by cliSupervisor.
 * OUTPUTS: null for a valid success, or a classified Error that converts the
 * otherwise exit-zero process into a failed run before run.completed emits.
 * NEIGHBORS: src/cliSupervisor.ts, src/providers/codexRuntime.ts
 */

import type { CliOptions } from "./types.js";
import { parseResult as parseCodexResult } from "./providers/codexRuntime.js";

const CODEX_MISSING_CUSTOM_TOOL_OUTPUT = "Custom tool call output is missing for call id:";

export class CodexMissingToolOutputError extends Error {
  constructor() {
    super("Codex custom tool call output is missing and no usable final response was produced");
    this.name = "CodexMissingToolOutputError";
  }
}

export function validateSuccessfulCliExit(
  bot: CliOptions["bot"],
  output: Readonly<{ stdout: string; stderr: string }>,
): Error | null {
  if (bot !== "codex") return null;
  if (!output.stderr.includes(CODEX_MISSING_CUSTOM_TOOL_OUTPUT)) return null;
  if (parseCodexResult(output.stdout).text.trim()) return null;
  return new CodexMissingToolOutputError();
}
