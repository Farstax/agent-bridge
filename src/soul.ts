/**
 * PURPOSE: Loads plain Markdown SOUL.md persona context for CLI prompt injection.
 * INPUTS: Markdown persona files, environment-derived mode/path options, and size limits.
 * OUTPUTS: Compact soul contract text or null when disabled/missing.
 * NEIGHBORS: src/cli.ts, src/promptWrapping.ts, docs/soul.md
 * LOGIC: Loads user-owned Markdown without prescribed headings, bounds size safely,
 * and frames it subordinate to higher-priority bridge/system/developer instructions.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type SoulMode = "summary" | "full" | "off";

const DEFAULT_SUMMARY_MAX_CHARS = 4_000;
const DEFAULT_FULL_MAX_CHARS = 12_000;

export function defaultSoulPath(projectDir: string = process.env.BRIDGE_PROJECT_DIR || process.cwd()): string {
  return join(projectDir, "SOUL.md");
}

export function normalizeSoulMode(raw: string | undefined): SoulMode {
  if (raw === "full" || raw === "off" || raw === "summary") return raw;
  return "summary";
}

export function loadSoulContext(input: { mode?: SoulMode; path?: string; maxChars?: number }): string | null {
  const mode = input.mode ?? "summary";
  if (mode === "off") return null;

  const path = input.path ?? defaultSoulPath();
  if (!existsSync(path)) return null;

  const raw = readFileSync(path, "utf8").trim();
  if (!raw) return null;

  const maxChars = input.maxChars ?? (mode === "full" ? DEFAULT_FULL_MAX_CHARS : DEFAULT_SUMMARY_MAX_CHARS);
  return capText(raw, maxChars);
}

const PRECEDENCE_NOTICE = "Higher-priority bridge/system/developer instructions always win.";

export function renderSoulContract(context: string | null): string | null {
  const trimmed = context?.trim();
  if (!trimmed) return null;
  const body = trimmed.includes(PRECEDENCE_NOTICE)
    ? trimmed
    : `${trimmed}\n\n${PRECEDENCE_NOTICE}`;
  return [
    "Soul contract:",
    body,
  ].join("\n");
}

function capText(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxChars - 16)).trimEnd()}\n[truncated]`;
}
