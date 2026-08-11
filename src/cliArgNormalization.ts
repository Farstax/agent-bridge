/**
 * PURPOSE: Provider-specific CLI argument policy (Codex, Antigravity/Agy).
 * INPUTS: A raw command name and its argument list.
 * OUTPUTS: The provider's canonical argument list.
 * NEIGHBORS: src/cliSupervisor.ts (calls this before spawning), src/cli.ts (re-exports)
 * LOGIC: Issue #135 Phase 2 — kept separate from cliSupervisor.ts, which must
 * stay provider-agnostic. The supervisor calls normalizeCliArgs() but does not
 * own Codex/Agy argument-shape decisions itself.
 */

import { basename } from "node:path";
import type { EffortLevel } from "./effort.js";

export function normalizeCliArgs(command: string, args: string[]): string[] {
  const cmdName = basename(command).toLowerCase();
  const isAgy = cmdName.includes("agy") || cmdName.includes("antigravity");
  const isCodex = cmdName.includes("codex");

  if (!isAgy && !isCodex) {
    return args;
  }

  // Parse original args to extract prompt, permissions, and output-format
  let prompt = "";
  let conversationId: string | null = null;
  let logFile: string | null = null;
  let printTimeout: string | null = null;
  let agyOutputFormat: "json" | "stream-json" | null = null;
  let model: string | null = null;
  let effort: EffortLevel | null = null;
  let resumeSessionId: string | null = null;
  const attachments: string[] = [];
  const disabledTools: string[] = [];
  let hasSandbox = false;
  let hasDoubleDash = false;
  let hasDashPrompt = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-") {
      hasDashPrompt = true;
    } else if (arg === "--") {
      hasDoubleDash = true;
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
        if (args[i + 1] === "json" || args[i + 1] === "stream-json") agyOutputFormat = args[i + 1] as "json" | "stream-json";
        i++;
      } else if (arg === "--output-format=json" || arg === "--output-format=stream-json") {
        agyOutputFormat = arg.slice("--output-format=".length) as "json" | "stream-json";
      } else if (arg === "--model") {
        model = args[i + 1] ?? null;
        i++;
      } else if (arg === "--effort") {
        effort = args[i + 1] as EffortLevel ?? null;
        i++;
      } else if (arg === "--resume") {
        resumeSessionId = args[i + 1] ?? null;
        i++;
      } else if (arg === "-i") {
        const att = args[i + 1];
        if (att) attachments.push(att);
        i++;
      } else if (arg === "--disable") {
        const tool = args[i + 1];
        if (tool) disabledTools.push(tool);
        i++;
      } else if (hasValue) {
        i++;
      }
    } else {
      if (isCodex && arg === "exec") {
        // skip
      } else if (isCodex && arg === "resume") {
        resumeSessionId = args[i + 1] ?? null;
        i++;
      } else {
        prompt = arg;
      }
    }
  }

  if (hasDashPrompt && !prompt) {
    prompt = "-";
  }

  let hasPermissionBypass = false;
  let hasJsonOutput = false;
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
    if (args[i] === "--json") {
      hasJsonOutput = true;
    }
    if (args[i] === "--output-format" && args[i + 1] === "json") {
      hasJsonOutput = true;
    }
    if (args[i] === "--output-format=json") {
      hasJsonOutput = true;
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
    if (agyOutputFormat) {
      newArgs.push("--output-format", agyOutputFormat);
    }
    newArgs.push("--print", prompt);
    return newArgs;
  }

  if (isCodex) {
    const newArgs: string[] = ["exec"];
    if (!effort) {
      for (let i = 0; i < args.length - 1; i += 1) {
        if ((args[i] === "-c" || args[i] === "--config") && args[i + 1]?.startsWith("model_reasoning_effort=")) {
          effort = args[i + 1].split("=", 2)[1]?.replace(/^"|"$/g, "") as EffortLevel;
          break;
        }
      }
    }
    if (resumeSessionId) {
      newArgs.push("resume", resumeSessionId);
    }
    if (effort) {
      newArgs.push("-c", `model_reasoning_effort="${effort}"`);
    }
    if (model) {
      newArgs.push("--model", model);
    }
    for (const tool of disabledTools) {
      newArgs.push("--disable", tool);
    }
    if (hasPermissionBypass) {
      newArgs.push("--dangerously-bypass-approvals-and-sandbox");
    }
    newArgs.push("--skip-git-repo-check");
    if (hasJsonOutput) {
      newArgs.push("--json");
    }
    if (attachments.length > 0) {
      for (const att of attachments) {
        newArgs.push("-i", att);
      }
      newArgs.push("--", "-");
    } else {
      newArgs.push(prompt);
    }
    return newArgs;
  }

  return args;
}
