/**
 * PURPOSE: Kimchi CLI invocation building, result parsing (thought/tool-call
 * stripping), and session-file resolution.
 * INPUTS: A ProviderInvocationRequest and raw Kimchi stdout; the cwd/homeDir
 * used to scan Kimchi's own session JSONL directory.
 * OUTPUTS: A { command, args } invocation, a parsed CliResult, and the
 * newest session UUID for a given cwd.
 * NEIGHBORS: src/cli.ts (buildCliInvocation/parseCliResult dispatch),
 * src/promptWrapping.ts
 * LOGIC: Issue #135 Phase 3C — moved out of src/cli.ts without behavioural
 * change; locked by test/providerInvocationFixtures.test.ts (Phase 3A/3B).
 * Kimchi has no native attachment support (annotated inline) and no stdout-
 * embedded session id — resolveKimchiSessionId() scans the CLI's own
 * session-file directory after each invocation instead.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CliResult } from "../types.js";
import { appendEffortArgs } from "../effort.js";
import { appendAttachmentAnnotations, appendOutputDirInstruction, wrapPromptContext } from "../promptWrapping.js";
import type { ProviderInvocation, ProviderInvocationRequest } from "./types.js";

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
  // Kimchi: --print for non-interactive mode, --model for model selection.
  // Session resume uses --resume <uuid> (UUID extracted from JSONL session filename).
  // Trusted mode maps to --yolo (no classifier guards).
  // Attachments are not supported; pass text annotations inline.
  const args: string[] = ["--print"];
  if (model) args.push("--model", model);
  if (executionMode === "trusted") {
    args.push("--yolo");
  }
  if (sessionId) {
    args.push("--resume", sessionId);
  } else {
    args.push("--no-session");
  }
  const annotatedPrompt = attachments.length > 0
    ? appendAttachmentAnnotations(prompt, attachments)
    : prompt;
  const finalPrompt = appendOutputDirInstruction(
    wrapPromptContext(annotatedPrompt, soulContext, includeResponseContract),
    outputDir,
  );
  args.push(finalPrompt);

  return { command, args: appendEffortArgs(command, args, effort), nativeSessionMode: sessionId ? "resume" : "fresh" };
}

/**
 * Kimchi outputs plain text to stdout. Session IDs are not embedded in stdout;
 * the JSONL session file is written to ~/.config/kimchi/harness/sessions/<cwd>/<uuid>.jsonl
 * by the CLI automatically. We cannot read the session ID from stdout, so we scan
 * the sessions directory for the most-recently-modified file after each invocation.
 *
 * Session resume: caller passes the UUID from a prior invocation as sessionId,
 * which is forwarded as --resume <uuid> to kimchi.
 */
export function parseResult(stdout: string): CliResult {
  // Kimchi --print emits plain text; extract session UUID if kimchi echoes it (it doesn't currently).
  // Session tracking is handled by the engine via resolveKimchiSessionId() after the process exits.
  let text = stdout.trim();

  // Strip tool calls section
  text = text.replace(/<\|tool_calls_section_begin[\s\S]*?<\|tool_calls_section_end\|>/g, "");
  text = text.replace(/<\|tool_call_begin[\s\S]*?<\|tool_call_end\|>/g, "");
  text = text.replace(/<\|tool_call_argument_begin[\s\S]*?<\|tool_call_argument_end\|>/g, "");

  // Strip thoughts / reasoning sections
  text = text.replace(/<\|thought_section_begin[\s\S]*?<\|thought_section_end\|>/g, "");
  text = text.replace(/<\|thought_begin[\s\S]*?<\|thought_end\|>/g, "");
  text = text.replace(/<\|thought[\s\S]*?<\|\/thought\|>/g, "");
  text = text.replace(/<\|thinking_section_begin[\s\S]*?<\|thinking_section_end\|>/g, "");
  text = text.replace(/<\|thinking_begin[\s\S]*?<\|thinking_end\|>/g, "");
  text = text.replace(/<\|thinking[\s\S]*?<\|\/thinking\|>/g, "");
  text = text.replace(/<\|reasoning_section_begin[\s\S]*?<\|reasoning_section_end\|>/g, "");
  text = text.replace(/<\|reasoning_begin[\s\S]*?<\|reasoning_end\|>/g, "");
  text = text.replace(/<\|reasoning[\s\S]*?<\|\/reasoning\|>/g, "");

  // Strip any remaining special tags starting with <| and ending with |>
  text = text.replace(/<\|.*?\|>/g, "");

  return { text: text.trim(), sessionId: null };
}

/**
 * Scan the kimchi sessions directory for the UUID of the most recently written session file.
 * Called by the engine after a kimchi invocation to persist the session for the next turn.
 *
 * Session files live at: ~/.config/kimchi/harness/sessions/<escaped-cwd>/<timestamp>_<uuid>.jsonl
 * We look in the directory matching the current cwd and return the UUID from the newest file.
 */
export function resolveKimchiSessionId(cwd: string, homeDir: string = homedir()): string | null {
  try {
    const sessionsRoot = join(homeDir, ".config", "kimchi", "harness", "sessions");
    const escapedCwd = cwd.replace(/[/\\]/g, "-").replace(/^-/, "");
    const sessionDir = join(sessionsRoot, escapedCwd);
    if (!existsSync(sessionDir)) return null;
    const files = readdirSync(sessionDir)
      .filter(f => f.endsWith(".jsonl"))
      .map(f => ({ name: f, mtime: statSync(join(sessionDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (!files.length) return null;
    // Filename format: <timestamp>_<uuid>.jsonl — extract the UUID part
    const match = files[0].name.match(/_([0-9a-f-]{36})\.jsonl$/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}
