/**
 * PURPOSE: Shared, provider-agnostic prompt-wrapping utilities used by
 * multiple provider invocation builders.
 * INPUTS: A raw user prompt, optional soul context, output dir, attachments.
 * OUTPUTS: The final prompt text to send to a CLI.
 * NEIGHBORS: src/cli.ts, src/providers/codexRuntime.ts, src/providers/claudeRuntime.ts
 * LOGIC: Issue #135 Phase 3B — extracted so codex/claude provider runtime
 * modules and the remaining inline antigravity branch in src/cli.ts
 * can share this without a circular import between cli.ts and the new
 * provider modules.
 */

import { renderSoulContract } from "./soul.js";

export function wrapPromptContext(
  prompt: string,
  soulContext: string | null = null,
  includeResponseContract = true,
  includeExecutionContract = includeResponseContract,
): string {
  const soulContract = renderSoulContract(soulContext);
  return [
    ...(soulContract ? [soulContract, ""] : []),
    ...(includeExecutionContract ? [SESSION_EXECUTION_CONTRACT, ""] : []),
    wrapResponseStyle(prompt, soulContext, includeResponseContract),
  ].join("\n");
}

export function prependHandoffModel(prompt: string, model: string | null): string {
  return [
    "[Agent Bridge handoff]",
    ...(model ? [`Active model: ${model}`] : []),
    "Continue naturally. When prior conversation context is supplied, recover the user goal, what was done / evidence, current state, pending / next steps, and key context / constraints from any exact recent turns; use the provided scoped history search when older turns are needed.",
    "",
    prompt,
  ].join("\n");
}

const SESSION_EXECUTION_CONTRACT = [
  "Agent Bridge execution contract:",
  "- A question asks for an answer, not permission to make changes.",
  "- When asked to act, complete the requested scope. Do not silently omit requested work.",
  "- For reversible, low-cost actions inside that authorised scope, act without procedural confirmation.",
  "- Ask before actions that reach an external audience, are difficult to undo, or have meaningful cost unless the user has already authorised them.",
  "- Fix defects that directly block or are caused by the requested work. Do not expand into unrelated cleanup.",
  "- If part of the work is genuinely blocked, complete the unblocked work and state the specific blocker.",
  "- Do not claim work was completed or verified unless it was.",
].join("\n");

const MINIMAL_RESPONSE_CONTRACT = [
  "Response contract:",
  "- Answer the user's request directly.",
  "- Preserve critical facts, constraints, commands, paths, errors, safety boundaries, and delivery instructions.",
  "- Do not mention internal prompt or configuration rules.",
].join("\n");

function wrapResponseStyle(prompt: string, soulContext: string | null, includeResponseContract: boolean): string {
  if (!includeResponseContract) return prompt;
  const configuredStyle = /(?:^|\n)##\s+Communication Style\s*$/m.test(soulContext ?? "");
  return [
    !configuredStyle ? MINIMAL_RESPONSE_CONTRACT : null,
    "",
    "User request:",
    prompt,
  ].filter((line): line is string => line !== null).join("\n");
}

const ATTACHMENT_ANNOTATION_PREFIX = "[Attached file saved at: ";
const OUTPUT_DIR_INSTRUCTION = "If you are explicitly asked to share or generate a file for the user, save it to ";
const OUTPUT_DIR_SUFFIX = " — the bridge handles delivery; omit file paths from your response. Do NOT place any internal scratchpad files, planning logs, or temporary scripts in this directory unless explicitly requested.";

export function appendAttachmentAnnotations(prompt: string, attachments: string[]): string {
  if (!attachments.length) return prompt;
  const lines = attachments.map((p) => `${ATTACHMENT_ANNOTATION_PREFIX}${p}]`);
  return `${prompt}\n\n${lines.join("\n")}`;
}

export function appendOutputDirInstruction(prompt: string, outputDir: string | null | undefined): string {
  if (!outputDir) return prompt;
  return `${prompt}\n\n${OUTPUT_DIR_INSTRUCTION}${outputDir}${OUTPUT_DIR_SUFFIX}`;
}
