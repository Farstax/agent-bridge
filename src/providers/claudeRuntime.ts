/**
 * PURPOSE: Claude CLI invocation building and result parsing.
 * INPUTS: A ProviderInvocationRequest and raw Claude stdout (plain text or
 * the last JSON `result` object).
 * OUTPUTS: A { command, args, stdin? } invocation and a parsed CliResult.
 * NEIGHBORS: src/cli.ts (buildCliInvocation/parseCliResult dispatch),
 * src/promptWrapping.ts, src/claudeSettings.ts, src/claudeStreamJson.ts
 * LOGIC: Issue #135 Phase 3B — moved out of src/cli.ts without behavioural
 * change; locked by test/providerInvocationFixtures.test.ts (Phase 3A).
 */

import type { CliResult } from "../types.js";
import { appendEffortArgs } from "../effort.js";
import { appendOutputDirInstruction, wrapPromptContext } from "../promptWrapping.js";
import { buildClaudeSettingsArg } from "../claudeSettings.js";
import { buildClaudeStreamJsonInput, parseClaudeStreamJsonOutput } from "../claudeStreamJson.js";
import type { ProviderInvocation, ProviderInvocationRequest } from "./types.js";

export function buildInvocation({
  prompt,
  sessionId,
  command,
  model,
  executionMode,
  outputFormat,
  soulContext,
  includeResponseContract,
  attachments,
  outputDir,
  effort,
  toolMode,
}: ProviderInvocationRequest): ProviderInvocation {
  const args: string[] = [];
  const finalPrompt = appendOutputDirInstruction(wrapPromptContext(prompt, soulContext, includeResponseContract), outputDir);
  if (attachments.length > 0) {
    // Multimodal path: pipe stream-json with base64 images to stdin.
    args.push(...buildClaudeSettingsArg());
    if (model) args.push("--model", model);
    if (sessionId) args.push("--resume", sessionId);
    if (executionMode === "trusted") args.push("--dangerously-skip-permissions");
    args.push("--input-format", "stream-json", "--output-format", "stream-json", "--verbose");
    const stdinPayload = buildClaudeStreamJsonInput(finalPrompt, attachments);
    return { command, args: appendEffortArgs(command, args, effort), stdin: stdinPayload, nativeSessionMode: sessionId ? "resume" : "fresh" };
  }
  args.push("--print");
  if (toolMode === "none") {
    args.push("--tools", "", "--disable-slash-commands", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}');
  }
  args.push(...buildClaudeSettingsArg());
  if (model) args.push("--model", model);
  if (sessionId) args.push("--resume", sessionId);
  if (executionMode === "trusted") args.push("--dangerously-skip-permissions");
  if (outputFormat === "json") args.push("--output-format", "json");
  if (outputFormat === "stream-json") args.push("--output-format", "stream-json", "--verbose");
  // Preserve the established argv contract for normal prompts, but terminate
  // option parsing when a raw prompt itself starts with a hyphen.
  if (finalPrompt.startsWith("-")) args.push("--");
  args.push(finalPrompt);

  return { command, args: appendEffortArgs(command, args, effort), nativeSessionMode: sessionId ? "resume" : "fresh" };
}

export function parseResult(stdout: string): CliResult {
  const transcript = parseClaudeStreamJsonOutput(stdout);
  if (transcript) return transcript;

  const lines = stdout.split("\n").map(l => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith("{")) continue;
    try {
      const obj = JSON.parse(lines[i]);
      if (obj.result != null) {
        return { text: String(obj.result).trim(), sessionId: obj.session_id ?? null };
      }
    } catch { /* not JSON */ }
  }
  return { text: stdout.trim(), sessionId: null };
}
