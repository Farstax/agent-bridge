import { buildCliInvocation, runCli, parseCliResult } from "../cli.js";
import type { HealthReport } from "./types.js";
import type { BotKind } from "../types.js";
import { resolveDefaultEffort } from "../effort.js";

const SUGGEST_TIMEOUT_MS = 600_000;

export function buildSuggestionPrompt(report: HealthReport): string {
  const failing = report.checks.filter(c => c.status !== "green");
  const lines = failing.map(c => `- ${c.name} (${c.status}): ${c.message}`).join("\n");
  return [
    `Health check for ${report.pluginName} returned ${report.status.toUpperCase()}.`,
    `Summary: ${report.summary}`,
    "",
    "Failing checks:",
    lines || "- (none individually flagged)",
    "",
    "List 2–4 numbered remediation options, ordered by likelihood. For each:",
    "1. One-line description of what it fixes",
    "2. Exact shell command or steps to apply it",
    "3. Mark one option as Recommended and include one concise rationale explaining why",
    "Keep each option brief. No preamble.",
  ].join("\n");
}

export function buildSuggestionInvocation(
  bot: BotKind,
  botConfig: { command: string; modelPreference: string[] },
  prompt: string,
): { command: string; args: string[] } {
  return buildCliInvocation({
    bot,
    command: botConfig.command,
    model: botConfig.modelPreference[0] ?? null,
    prompt,
    sessionId: null,
    effort: resolveDefaultEffort(bot),
    executionMode: "safe",
    outputFormat: bot !== "antigravity" ? "json" : null,
  });
}

export async function generateSuggestion(
  report: HealthReport,
  bot: BotKind,
  botConfig: { command: string; modelPreference: string[] },
): Promise<string | null> {
  const prompt = buildSuggestionPrompt(report);
  const invocation = buildSuggestionInvocation(bot, botConfig, prompt);
  try {
    const stdout = await runCli(invocation.command, invocation.args, process.cwd(), {
      timeoutMs: SUGGEST_TIMEOUT_MS,
      bot,
    });
    const result = parseCliResult({ bot, stdout, logContent: null });
    const text = result.text.trim();
    if (/^(error:|timed out|execution error)/i.test(text)) {
      return null;
    }
    return text || null;
  } catch {
    return null;
  }
}
