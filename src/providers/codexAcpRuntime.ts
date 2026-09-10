/**
 * PURPOSE: Compatibility facade for Codex ACP callers.
 * Generic ACP lifecycle/orchestration lives in acpRuntime.ts; Codex-specific
 * authority/config/phase policy lives in codexAcpPolicy.ts.
 */
import type { AcpTurnResult } from "../acp/client.js";
import type { CliOptions, CliResult } from "../types.js";
import type { ProviderInvocation, ProviderInvocationRequest } from "./types.js";
import {
  acpTurnResultToCliResult,
  buildAcpProviderInvocation,
  runAcpProviderTurn,
} from "./acpRuntime.js";

export {
  CodexAcpToolFreeUnsupportedError,
  codexAcpChildAuthEnv,
  codexAcpConfig,
  initialAgentMode,
} from "./codexAcpPolicy.js";

/** @deprecated Prefer provider-neutral buildCliInvocation()/resolved ACP runtime. */
export function buildInvocation(request: ProviderInvocationRequest): ProviderInvocation {
  return buildAcpProviderInvocation("codex", request);
}

/** @deprecated Prefer provider-neutral ACP result conversion. */
export function toCliResult(result: AcpTurnResult): CliResult {
  return acpTurnResultToCliResult("codex", result);
}

/** @deprecated Prefer runAcpProviderTurn(providerId, ...). */
export async function runTurn(
  request: ProviderInvocationRequest,
  cwd: string,
  options: CliOptions,
  identities: { conversationId: string; runId: string },
): Promise<CliResult> {
  return runAcpProviderTurn("codex", request, cwd, options, identities);
}
