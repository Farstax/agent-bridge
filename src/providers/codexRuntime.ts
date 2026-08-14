/**
 * PURPOSE: Codex CLI invocation building and result parsing.
 * INPUTS: A ProviderInvocationRequest (prompt, session, model, execution
 * mode, attachments, etc.) and raw Codex JSONL stdout.
 * OUTPUTS: A { command, args, stdin? } invocation and a parsed CliResult.
 * NEIGHBORS: src/cli.ts (buildCliInvocation/parseCliResult dispatch),
 * src/promptWrapping.ts, src/effort.ts
 * LOGIC: Issue #135 Phase 3B — moved out of src/cli.ts without behavioural
 * change; locked by test/providerInvocationFixtures.test.ts (Phase 3A).
 */

import type { CliResult } from "../types.js";
import { appendEffortArgs } from "../effort.js";
import { appendOutputDirInstruction, wrapPromptContext } from "../promptWrapping.js";
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

  const forceFreshForAttachments = attachments.length > 0;
  if (sessionId && !forceFreshForAttachments) {
    args.push("exec", "resume", sessionId);
  } else {
    if (sessionId && forceFreshForAttachments) {
      console.warn("[bridge] Codex: starting fresh session for attachment turn because resume does not support -i");
    }
    args.push("exec");
  }
  if (toolMode === "none") {
    args.push(
      "--disable", "shell_tool",
      "--disable", "browser_use",
      "--disable", "computer_use",
      "--disable", "plugins",
      "--disable", "guardian_approval",
      "--disable", "hooks",
      "--disable", "goals",
      "--disable", "apps"
    );
  }
  args.push("--skip-git-repo-check");
  if (model) {
    args.push("--model", model);
  }
  if (executionMode === "trusted") {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  }
  if (outputFormat === "json") {
    args.push("--json");
  }
  const finalPrompt = appendOutputDirInstruction(wrapPromptContext(prompt, soulContext, includeResponseContract), outputDir);
  // Codex supports -i <file> for image attachments on fresh exec invocations.
  // Because --image accepts multiple files, pass the prompt via stdin to avoid
  // the prompt being parsed as another image path.
  if (attachments.length > 0) {
    for (const att of attachments) {
      args.push("-i", att);
    }
    args.push("--", "-");
    return { command, args: appendEffortArgs(command, args, effort), stdin: finalPrompt, nativeSessionMode: "fresh" };
  }
  args.push(finalPrompt);

  return { command, args: appendEffortArgs(command, args, effort), nativeSessionMode: sessionId && !forceFreshForAttachments ? "resume" : "fresh" };
}

export function parseResult(stdout: string): CliResult {
  let sessionId: string | null = null;
  let finalText: string | null = null;
  const deltaChunks: string[] = [];

  const lines = stdout.split("\n").map((v) => v.trim()).filter(Boolean);
  for (const line of lines) {
    if (!line.startsWith("{")) continue;
    try {
      const e = JSON.parse(line);
      if (e.type === "thread.started" && e.thread_id) {
        sessionId = e.thread_id;
      } else if (
        (e.type === "item.completed" || e.type === "item.updated") &&
        e.item?.type === "agent_message" &&
        typeof e.item.text === "string"
      ) {
        finalText = e.item.text;
      } else if (e.type === "response.completed" && typeof e.output_text === "string") {
        finalText = e.output_text;
      } else if (e.type === "response.output_text.delta" && e.delta) {
        deltaChunks.push(e.delta);
      }
    } catch {
      // not JSON, skip
    }
  }

  return {
    text: (finalText ?? deltaChunks.join("")).trim(),
    sessionId,
  };
}

export function hasUsableFinalResponse(stdout: string): boolean {
  const lines = stdout.split("\n").map((v) => v.trim()).filter(Boolean);
  for (const line of lines) {
    if (!line.startsWith("{")) continue;
    try {
      const e = JSON.parse(line);
      if (
        e.type === "item.completed" &&
        e.item?.type === "agent_message" &&
        typeof e.item.text === "string" &&
        e.item.text.trim()
      ) {
        return true;
      }
      if (
        e.type === "response.completed" &&
        typeof e.output_text === "string" &&
        e.output_text.trim()
      ) {
        return true;
      }
    } catch {
      // not JSON, skip
    }
  }
  return false;
}
