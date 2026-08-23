/**
 * PURPOSE: Grok Build headless streaming-json invocation and fail-closed parsing.
 * INPUTS: A ProviderInvocationRequest and raw Grok NDJSON stdout.
 * OUTPUTS: A { command, args } invocation and a parsed CliResult.
 * NEIGHBORS: src/cli.ts dispatch, existing supervised process / Run owners.
 * LOGIC: Issue #96 after #416 selected headless streaming-json, not ACP.
 */

import type { CliResult } from "../types.js";
import { appendEffortArgs } from "../effort.js";
import { appendOutputDirInstruction, wrapPromptContext } from "../promptWrapping.js";
import type { ProviderInvocation, ProviderInvocationRequest } from "./types.js";

const IGNORED_EVENT_TYPES = new Set([
  "thought",
  "tool",
  "tool_call",
  "tool_call_update",
  "command",
  "usage",
  "permission",
  "protocol",
  "plan",
  "available_commands",
  "stderr",
]);

export function buildInvocation({
  prompt,
  sessionId,
  command,
  model,
  executionMode,
  soulContext,
  includeResponseContract,
  attachments,
  outputDir,
  effort,
}: ProviderInvocationRequest): ProviderInvocation {
  if (attachments.length > 0) {
    throw new Error("Grok Build headless streaming-json does not support attachment invocation");
  }
  const finalPrompt = appendOutputDirInstruction(
    wrapPromptContext(prompt, soulContext, includeResponseContract),
    outputDir,
  );
  const args = ["-p", finalPrompt, "--output-format", "streaming-json"];
  if (sessionId) args.push("--resume", sessionId);
  if (model) args.push("--model", model);
  if (executionMode === "trusted") args.push("--always-approve");
  return {
    command,
    args: appendEffortArgs(command, args, effort),
    nativeSessionMode: sessionId ? "resume" : "fresh",
  };
}

export function parseResult(stdout: string): CliResult {
  const answerChunks: string[] = [];
  let sessionId: string | null = null;
  let sawEnd = false;
  let errorMessage: string | null = null;

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      throw new Error("Grok streaming-json output was malformed");
    }
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      throw new Error("Grok streaming-json output was malformed");
    }
    const record = event as Record<string, unknown>;
    const type = record.type;
    if (type === "text") {
      if (typeof record.data !== "string") {
        throw new Error("Grok streaming-json text event was malformed");
      }
      answerChunks.push(record.data);
      continue;
    }
    if (type === "end") {
      if (typeof record.sessionId !== "string" || !record.sessionId.trim()) {
        throw new Error("Grok terminal session evidence was missing");
      }
      sessionId = record.sessionId;
      sawEnd = true;
      continue;
    }
    if (type === "error") {
      errorMessage = typeof record.message === "string" && record.message.trim()
        ? record.message
        : "Grok reported an error";
      continue;
    }
    if (typeof type === "string" && IGNORED_EVENT_TYPES.has(type)) continue;
    throw new Error("Grok streaming-json contained an unknown event type");
  }

  if (errorMessage) throw new Error(errorMessage);
  if (!sawEnd || !sessionId) {
    throw new Error("Grok terminal session evidence was missing");
  }
  const text = answerChunks.join("");
  if (!text.trim()) {
    throw new Error("Grok streaming-json did not emit answer text");
  }
  return { text, sessionId };
}
