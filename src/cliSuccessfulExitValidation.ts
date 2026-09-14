/**
 * PURPOSE: Provider-specific validation for successful CLI process exits.
 * INPUTS: Provider kind plus complete stdout/stderr captured by cliSupervisor.
 * OUTPUTS: null for a valid success, or a classified Error that converts the
 * otherwise exit-zero process into a failed run before run.completed emits.
 * NEIGHBORS: src/cliSupervisor.ts and native provider runtimes.
 */

import type { CliOptions } from "./types.js";

export function validateSuccessfulCliExit(
  _bot: CliOptions["bot"],
  _output: Readonly<{ stdout: string; stderr: string }>,
): Error | null {
  // Every provider is ACP-backed now; there is no remaining native CLI
  // provider whose exit-zero output needs structured re-validation here.
  return null;
}
