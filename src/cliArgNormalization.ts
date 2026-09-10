/**
 * PURPOSE: Provider-specific CLI argument policy for Antigravity/Agy.
 * INPUTS: A raw command name and its argument list.
 * OUTPUTS: The provider's canonical argument list.
 * NEIGHBORS: src/cliSupervisor.ts (calls this before spawning), src/cli.ts (re-exports)
 * LOGIC: Issue #135 Phase 2 — kept separate from cliSupervisor.ts, which must
 * stay provider-agnostic. The supervisor calls normalizeCliArgs() but does not
 * own Agy argument-shape decisions itself. Codex ACP arguments are already in
 * adapter form and pass through unchanged.
 */

import { basename } from "node:path";
export function normalizeCliArgs(command: string, args: string[]): string[] {
  const cmdName = basename(command).toLowerCase();
  const isAgy = cmdName.includes("agy") || cmdName.includes("antigravity");

  if (!isAgy) {
    return args;
  }

  // Parse original args to extract prompt, permissions, and provider options.
  let prompt = "";
  let conversationId: string | null = null;
  let logFile: string | null = null;
  let printTimeout: string | null = null;
  let hasSandbox = false;
  let hasDashPrompt = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-") {
      hasDashPrompt = true;
    } else if (arg === "--sandbox") {
      hasSandbox = true;
    } else if (arg.startsWith("-")) {
      const hasValue = [
        "--model",
        "--resume",
        "--permission-mode",
        "--output-format",
        "--input-format",
        "--settings",
        "--effort",
        "--log-file",
        "-i",
        "--conversation",
        "--print-timeout",
        "-c",
        "--config",
        "--disable",
      ].includes(arg);

      if (arg === "--conversation") {
        conversationId = args[i + 1] ?? null;
        i++;
      } else if (arg === "--log-file") {
        logFile = args[i + 1] ?? null;
        i++;
      } else if (arg === "--print-timeout") {
        printTimeout = args[i + 1] ?? null;
        i++;
      } else if (arg === "--output-format") {
        // Consume stale provider-mode hints. Agy is normalized to stream-json below.
        i++;
      } else if (arg.startsWith("--output-format=")) {
        // Consume stale provider-mode hints. Agy is normalized to stream-json below.
      } else if (hasValue) {
        i++;
      }
    } else {
      prompt = arg;
    }
  }

  if (hasDashPrompt && !prompt) {
    prompt = "-";
  }

  let hasPermissionBypass = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dangerously-skip-permissions") {
      hasPermissionBypass = true;
    }
    if (args[i] === "--dangerously-bypass-approvals-and-sandbox") {
      hasPermissionBypass = true;
    }
    if (args[i] === "--permission-mode" && args[i + 1] === "acceptEdits") {
      hasPermissionBypass = true;
    }
  }

  if (isAgy) {
    const newArgs: string[] = [];
    if (conversationId) {
      newArgs.push("--conversation", conversationId);
    }
    if (hasPermissionBypass) {
      newArgs.push("--dangerously-skip-permissions");
    }
    if (logFile) {
      newArgs.push("--log-file", logFile);
    }
    if (hasSandbox) {
      newArgs.push("--sandbox");
    }
    if (printTimeout) {
      newArgs.push("--print-timeout", printTimeout);
    }
    newArgs.push("--output-format", "stream-json");
    newArgs.push("--print", prompt);
    return newArgs;
  }

  return args;
}
