/**
 * PURPOSE: Cursor CLI headless invocation and fail-closed parsing.
 * INPUTS: A ProviderInvocationRequest and raw Cursor json/stream-json stdout.
 * OUTPUTS: A { command, args } invocation and a parsed CliResult.
 * NEIGHBORS: src/cli.ts dispatch, existing supervised process / Run owners.
 * LOGIC: Issue #561 after #552 qualified cursor-agent headless contracts.
 */

import type { CliResult } from "../types.js";
import { appendOutputDirInstruction, wrapPromptContext } from "../promptWrapping.js";
import type { ProviderInvocation, ProviderInvocationRequest } from "./types.js";

const IGNORED_STREAM_TYPES = new Set([
  "system",
  "user",
  "assistant",
  "thinking",
  "tool",
  "tool_call",
  "tool_call_update",
  "command",
  "usage",
  "permission",
  "protocol",
  "plan",
]);

function resolveOutputFormat(outputFormat: ProviderInvocationRequest["outputFormat"]): "json" | "stream-json" {
  return outputFormat === "stream-json" ? "stream-json" : "json";
}

function extractResultText(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  return null;
}

function parseResultObject(record: Record<string, unknown>): CliResult {
  if (record.type !== "result") {
    throw new Error("Cursor structured output was missing a terminal result");
  }
  if (record.is_error === true || record.subtype === "error") {
    const detail = extractResultText(record.result) ?? extractResultText(record.message) ?? "reported an error";
    throw new Error(`Cursor terminal result failed: ${detail}`);
  }
  if (record.subtype != null && record.subtype !== "success") {
    throw new Error(`Cursor terminal subtype was unrecognized: ${String(record.subtype)}`);
  }
  const text = extractResultText(record.result);
  if (!text) {
    throw new Error("Cursor terminal result text was missing");
  }
  const sessionId = typeof record.session_id === "string" && record.session_id.trim()
    ? record.session_id
    : null;
  if (!sessionId) {
    throw new Error("Cursor terminal session evidence was missing");
  }
  return { text, sessionId };
}

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
}: ProviderInvocationRequest): ProviderInvocation {
  if (attachments.length > 0) {
    throw new Error("Cursor headless invocation does not support attachment invocation");
  }
  const finalPrompt = appendOutputDirInstruction(
    wrapPromptContext(prompt, soulContext, includeResponseContract),
    outputDir,
  );
  const args = ["-p", finalPrompt, "--output-format", resolveOutputFormat(outputFormat)];
  if (sessionId) args.push("--resume", sessionId);
  if (model) args.push("--model", model);
  if (executionMode === "trusted") {
    // Qualified #552 trusted-workspace edit contract. Host --sandbox enabled is
    // not required; Agent Bridge owns surrounding execution safety.
    args.push("--trust", "--sandbox", "disabled");
  } else {
    // Cursor docs say headless/print mode otherwise has write access. Safe mode
    // therefore uses the live-qualified Ask read-only contract (#552) plus
    // --trust so headless runs are not blocked on an interactive trust prompt.
    args.push("--mode", "ask", "--trust");
  }
  return {
    command,
    args,
    nativeSessionMode: sessionId ? "resume" : "fresh",
  };
}

export function parseResult(stdout: string): CliResult {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) {
    throw new Error("Cursor terminal result was missing");
  }

  let terminal: CliResult | null = null;
  for (const line of lines) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      throw new Error("Cursor structured output was malformed");
    }
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      throw new Error("Cursor structured output was malformed");
    }
    if (terminal) {
      throw new Error("Cursor structured output contained data after terminal result");
    }
    const record = event as Record<string, unknown>;
    const type = record.type;
    if (type === "result") {
      terminal = parseResultObject(record);
      continue;
    }
    if (typeof type === "string" && IGNORED_STREAM_TYPES.has(type)) {
      continue;
    }
    if (typeof type === "string") {
      // Unknown event types fail closed so future Cursor envelopes cannot be
      // silently dropped into the answer text.
      throw new Error(`Cursor structured output contained an unknown event type: ${type}`);
    }
    // Single-object json success shape without a preceding stream.
    if ("result" in record && ("session_id" in record || record.type == null)) {
      terminal = parseResultObject({ type: "result", subtype: "success", is_error: false, ...record });
    }
  }

  if (!terminal) {
    throw new Error("Cursor terminal result was missing");
  }
  return terminal;
}
