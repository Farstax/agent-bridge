/**
 * PURPOSE: Telegram bot commands routing and utility generation.
 * INPUTS: Chat messages and bot kind, configuration, and database instances.
 * OUTPUTS: A CommandResult specifying messages to send or prompt execution overrides.
 * NEIGHBORS: src/index.ts, src/bridge.ts, src/types.ts
 * LOGIC: Normalizes user commands and routes "/start", "/reset", "/models", "/skills" to appropriate action structures.
 */

import type { BridgeConfig } from "./types.js";
import type { BridgeDb } from "./db.js";
import { buildModelKeyboard, buildModelsText } from "./bridge.js";
import { listLocalCatalog } from "./skills.js";
import { buildEffortKeyboard, buildEffortText, resolveEffort } from "./effort.js";
import { preseedCompactMode, preseedCompactCharThreshold } from "./contextPolicy.js";
import { parseAdvisorConfig } from "./advisorConfig.js";
import { inspectAdvisorConfigSources } from "./advisorConfigSource.js";
import { buildBusyMessageModeKeyboard, resolveLaneBusyMessageMode, type BusyMessageMode } from "./busyMessageMode.js";

const CONTEXT_COMPACT_NUDGE_TURNS = 100;

export type CommandResult =
  | { kind: "message"; text: string }
  | { kind: "keyboard_message"; text: string; reply_markup: any }
  | { kind: "execute"; prompt: string }
  | { kind: "codex_usage" }
  | { kind: "compact"; chatKey: string }
  | { kind: "advisor"; action: "ask" | "review" | "plan" | "debug"; task: string; chatKey: string }
  | { kind: "btw"; prompt: string };

const bridgeCommands = new Set(["/start", "/reset", "/models", "/effort", "/queue_mode", "/skills", "/usage", "/narration", "/compact", "/context", "/advisor", "/btw"]);
const START_PAYLOAD_MAX_LENGTH = 64;
const START_PAYLOAD_PATTERN = /^[a-z0-9-]+$/;

function normalizeCommand(text: string): string {
  const [command] = String(text || "").trim().toLowerCase().split(/\s+/, 1);
  return command.replace(/@\S+$/, "");
}

function startPayloadExecution(prompt: string): CommandResult | null {
  const match = String(prompt || "").trim().match(/^\/start(?:@\S+)?\s+([^\s]+)$/i);
  const payload = match?.[1] || "";
  if (!payload || payload.length > START_PAYLOAD_MAX_LENGTH || !START_PAYLOAD_PATTERN.test(payload)) return null;
  return {
    kind: "execute",
    prompt: `Investigate this issue using the available local agent skills and tools. Bounded context: ${payload}`,
  };
}

export function isBridgeCommand(text: string): boolean {
  return bridgeCommands.has(normalizeCommand(text));
}

export function antigravityNarrationSettingKey(chatId: string): string {
  return `antigravity:narration:${chatId}`;
}

export function compactInProgressSettingKey(chatId: string): string {
  return `compact_in_progress:${chatId}`;
}

export function isAntigravityNarrationVisible(db: BridgeDb, chatId: string): boolean {
  return db.getSetting(antigravityNarrationSettingKey(chatId)) === "visible";
}

function handleNarrationCommand(kind: "codex" | "antigravity" | "claude" | "kimchi", text: string, db: BridgeDb, chatId: string): CommandResult {
  if (kind !== "antigravity") {
    return { kind: "message", text: "/narration is only available on Antigravity." };
  }

  const [, rawMode = "status"] = String(text || "").trim().toLowerCase().split(/\s+/, 2);
  const key = antigravityNarrationSettingKey(chatId);
  const current = isAntigravityNarrationVisible(db, chatId);
  const next =
    rawMode === "on" || rawMode === "visible" ? true :
    rawMode === "off" || rawMode === "hidden" ? false :
    rawMode === "toggle" ? !current :
    current;

  if (!["on", "visible", "off", "hidden", "toggle", "status"].includes(rawMode)) {
    return { kind: "message", text: "Usage: /narration on|off|status" };
  }

  if (rawMode !== "status") {
    db.setSetting(key, next ? "visible" : "hidden");
  }

  return {
    kind: "message",
    text: next
      ? "Agy narration is visible. STATUS updates may appear while Antigravity works."
      : "Agy narration is hidden. STATUS updates only refresh typing.",
  };
}

function buildSkillsText(): string {
  const skills = listLocalCatalog();
  if (skills.length === 0) return "No bundled agent-bridge skills were found.";

  return [
    "Bundled agent-bridge skills:",
    ...skills.map((skill) => `- ${skill.name} - ${skill.description}`),
    "",
    "Install or repair locally:",
    "npm run skills -- install <skill-name>",
    "npm run skills -- verify --fix",
  ].join("\n");
}

export function handleCommand(
  kind: "codex" | "antigravity" | "claude" | "kimchi",
  prompt: string,
  {
    db,
    chatId,
    config,
    surfaceIdentity = "diagnostic",
    defaultBusyMessageMode = "augment",
  }: {
    db: BridgeDb;
    chatId: string;
    config: BridgeConfig;
    surfaceIdentity?: string;
    defaultBusyMessageMode?: BusyMessageMode;
  }
): CommandResult | null {
  const text = normalizeCommand(prompt);

  if (text === "/start") {
    const execution = startPayloadExecution(prompt);
    if (execution) return execution;
    return {
      kind: "message",
      text: `${kind} bridge ready. use /models to change model, or just send a message to start a thread.`,
    };
  }

  if (text === "/reset") {
    db.setSession(chatId, kind, null);
    db.clearConvHistory(chatId);
    return { kind: "message", text: `${kind} session reset. Pending work and conversation history cleared.` };
  }

  if (text === "/models") {
    const bot = config.bots[kind];
    return {
      kind: "keyboard_message",
      text: buildModelsText(kind, { db, config }),
      reply_markup: buildModelKeyboard(kind, bot.modelPreference, db.getSetting(kind)),
    };
  }

  if (text === "/effort") {
    const current = resolveEffort(kind, db);
    return {
      kind: "keyboard_message",
      text: buildEffortText(kind, current),
      reply_markup: buildEffortKeyboard(kind, current),
    };
  }

  if (text === "/queue_mode") {
    const effective = resolveLaneBusyMessageMode(db, surfaceIdentity, chatId, defaultBusyMessageMode);
    return {
      kind: "keyboard_message",
      text: `Busy-message mode: ${effective}. This applies to new messages while this lane is busy.`,
      reply_markup: buildBusyMessageModeKeyboard(effective),
    };
  }

  if (text === "/skills") {
    return {
      kind: "message",
      text: buildSkillsText(),
    };
  }

  if (text === "/narration") {
    return handleNarrationCommand(kind, prompt, db, chatId);
  }

  if (text === "/usage") {
    if (kind !== "codex") {
      return {
        kind: "message",
        text: "/usage is only available on the Codex bridge.",
      };
    }
    return { kind: "codex_usage" };
  }

  if (text === "/compact") {
    return { kind: "compact", chatKey: chatId };
  }

  if (text === "/advisor") {
    const [, rawAction = "status", ...rest] = String(prompt || "").trim().split(/\s+/);
    const action = rawAction.toLowerCase();
    const advisor = parseAdvisorConfig();
    if (action === "status") {
      const chain = advisor.chain.length
        ? advisor.chain.map((target) => `${target.provider}:${target.model}`).join(" -> ")
        : "not configured";
      const diagnostics = inspectAdvisorConfigSources();
      const matches = diagnostics.effectiveChainMatches.length > 0
        ? diagnostics.effectiveChainMatches.join(" and ")
        : "no readable configured file";
      const lines = [
        `Advisor: ${advisor.enabled ? "enabled" : "disabled"}`,
        `Mode: ${advisor.mode}`,
        `Chain: ${chain}`,
        `Effective source: ${diagnostics.effectiveChainSource}`,
        `Effective chain matches: ${matches}`,
        `Budgets: ${advisor.maxCallsPerTurn}/turn, ${advisor.maxCallsPerTask}/task`,
      ];
      if (diagnostics.driftKeys.length > 0) {
        lines.push(
          `Configuration drift: ${diagnostics.driftKeys.join(", ")} differ between ${diagnostics.repoEnvPath} and ${diagnostics.systemdEnvPath}.`,
          "Update the authoritative systemd defaults and restart the affected Agent Bridge services.",
        );
      } else if (diagnostics.repoReadable && diagnostics.systemdReadable) {
        lines.push("Configuration drift: none detected.");
      } else {
        lines.push("Configuration drift: not evaluated because both configuration files are not readable.");
      }
      return { kind: "message", text: lines.join("\n") };
    }
    if (!["ask", "review", "plan", "debug"].includes(action)) {
      return { kind: "message", text: "Usage: /advisor status|ask <question>|review|plan <goal>|debug <problem>" };
    }
    const supplied = rest.join(" ").trim();
    if (["ask", "plan", "debug"].includes(action) && !supplied) {
      return { kind: "message", text: `Usage: /advisor ${action} <text>` };
    }
    const task = supplied || "Review the current conversation and identify missed risks, weak assumptions, and next steps.";
    return { kind: "advisor", action: action as "ask" | "review" | "plan" | "debug", task, chatKey: chatId };
  }

  if (text === "/btw") {
    const btwPrompt = String(prompt || "").trim().replace(/^\/btw\S*\s*/i, "").trim();
    if (!btwPrompt) {
      return { kind: "message", text: "Usage: /btw <prompt> — a fresh, read-only, one-off side question that does not disturb the active session." };
    }
    return { kind: "btw", prompt: btwPrompt };
  }

  if (text === "/context") {
    const status = db.getConvStatus(chatId, surfaceIdentity);
    const summary = db.getLatestConvSummary(chatId);
    const latestAttempt = db.getLatestCompactionAttempt(chatId);
    const compactStartedAt = db.getSetting(compactInProgressSettingKey(chatId));
    const turnWord = status.turnCount === 1 ? "1 turn" : `${status.turnCount} turns`;
    const lines = [
      `**Context status** for \`${chatId}\``,
      `Stored: ${turnWord}`,
      `Pending queue: ${status.pendingCount}`,
      `Latest turn: ${status.latestTurnAt ?? "none"}`,
      `Latest successful compact: ${status.latestSummaryAt ?? "never"}`,
      `Latest compact attempt: ${latestAttempt?.ended_at ?? "never"}`,
    ];
    if (latestAttempt) {
      lines.push(
        `Outcome: ${latestAttempt.outcome}${latestAttempt.error_category ? ` (${latestAttempt.error_category})` : ""}`,
        `Trigger: ${latestAttempt.trigger}`,
        `Provider/model: ${latestAttempt.provider} / ${latestAttempt.model ?? "default"}`,
        `Calls/chunks: ${latestAttempt.cli_call_count} / ${latestAttempt.chunk_count}`,
        `Duration: ${latestAttempt.duration_ms} ms`,
        `Turn range: ${latestAttempt.range_start_turn_id ?? "none"}-${latestAttempt.range_end_turn_id ?? "none"}`,
      );
    }
    if (compactStartedAt) {
      lines.push(`Compact: in progress since ${compactStartedAt}`);
    }
    if (summary) {
      const turnsSince = db.getRecentConvTurns(chatId, 1000, summary.range_end_turn_id).length;
      lines.push(`Turns since last compact: ${turnsSince}`);
    }
    if (status.turnCount > CONTEXT_COMPACT_NUDGE_TURNS) {
      lines.push("High turn count - consider /compact");
    }

    const preseedMode = preseedCompactMode();
    const uncompacted = db.getUncompactedConvStats(chatId);
    const memoryCount = db.getMemoryCount();
    lines.push(
      "",
      `Pre-seed compact: ${preseedMode === "auto" ? `auto (threshold ${preseedCompactCharThreshold()} chars)` : "off"}`,
      `Uncompacted: ${uncompacted.turnCount} turns, ${uncompacted.charCount} chars`,
      `Memory count: ${memoryCount}`,
    );

    return { kind: "message", text: lines.join("\n") };
  }

  return null;
}

export function buildTelegramCommands(kind: "codex" | "antigravity" | "claude" | "kimchi"): Array<{ command: string; description: string }> {
  const commands = [
    { command: "models",   description: "Switch model" },
    { command: "effort",   description: "Switch reasoning effort" },
    { command: "queue_mode", description: "Set busy-message handling" },
    { command: "reset",    description: "Reset session and clear conversation history" },
    { command: "stop",     description: "Abort running execution" },
    { command: "compact",  description: "Compact conversation context" },
    { command: "context",  description: "Show context status" },
    { command: "advisor",  description: "Ask frontier advisor" },
    { command: "btw",      description: "Fresh read-only side question" },
  ];

  if (kind === "codex") {
    commands.push({ command: "usage", description: "Show Codex plan usage" });
  }
  if (kind === "antigravity") {
    commands.push({ command: "narration", description: "Toggle Agy narration visibility" });
  }

  return commands;
}
