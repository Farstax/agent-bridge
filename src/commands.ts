/**
 * PURPOSE: Telegram bot commands routing and utility generation.
 * INPUTS: Chat messages and bot kind, configuration, and database instances.
 * OUTPUTS: A CommandResult specifying messages to send or prompt execution overrides.
 * NEIGHBORS: src/index.ts, src/bridge.ts, src/types.ts
 * LOGIC: Normalizes user commands and routes built-ins to action structures.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { BridgeConfig, BotKind } from "./types.js";
import type { BridgeDb } from "./db.js";
import { buildModelKeyboard, buildModelsText } from "./bridge.js";
import { listLocalCatalog } from "./skills.js";
import { buildEffortKeyboard, buildEffortText, resolveEffort } from "./effort.js";
import { buildBusyMessageModeKeyboard, resolveLaneBusyMessageMode, type BusyMessageMode } from "./busyMessageMode.js";

export type CommandResult =
  | { kind: "message"; text: string }
  | { kind: "keyboard_message"; text: string; reply_markup: any }
  | { kind: "execute"; prompt: string }
  | { kind: "codex_usage" }
  | { kind: "btw"; prompt: string };

const bridgeCommands = new Set(["/start", "/reset", "/models", "/effort", "/queue_mode", "/skills", "/usage", "/narration", "/context", "/btw"]);
export const START_PAYLOAD_MAX_LENGTH = 64;
export const START_PAYLOAD_PATTERN = /^[a-z0-9-]+$/;

function normalizeCommand(text: string): string {
  const [command] = String(text || "").trim().toLowerCase().split(/\s+/, 1);
  return command.replace(/@\S+$/, "");
}

export function parseStartPayload(prompt: string): string | null {
  const match = String(prompt || "").trim().match(/^\/start(?:@\S+)?\s+([^\s]+)$/i);
  const payload = match?.[1] || "";
  if (!payload || payload.length > START_PAYLOAD_MAX_LENGTH || !START_PAYLOAD_PATTERN.test(payload)) return null;
  return payload;
}

const INVESTIGATION_ID_PATTERN = /\bapp-[a-z0-9-]+-2x-[a-z0-9-]+-([a-f0-9]{12})$/;

export function extractInvestigationId(payload: string): string | null {
  return INVESTIGATION_ID_PATTERN.exec(String(payload || ""))?.[1] ?? null;
}

export interface InvestigationEvidence {
  investigationId: string;
  applicationName: string;
  workspaceId: string;
  status: string;
  reason: string;
  checkedAt: string;
  correlationId: string;
}

const EVIDENCE_FIELD_MAX_LENGTH = 200;
const EVIDENCE_FILE_MAX_BYTES = 4096;
const EVIDENCE_REQUIRED_STRING_FIELDS: Array<keyof InvestigationEvidence> = [
  "investigationId",
  "applicationName",
  "workspaceId",
  "status",
  "reason",
  "checkedAt",
  "correlationId",
];

function defaultInvestigationsDir(): string {
  return process.env.AGENT_BRIDGE_INVESTIGATIONS_DIR || "/var/lib/agent-bridge/investigations";
}

function sanitizeEvidenceField(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\x00-\x1f\x7f]+/g, " ").trim();
}

export function readInvestigationEvidence(
  investigationId: string,
  dir: string = defaultInvestigationsDir(),
): InvestigationEvidence | null {
  if (!investigationId || !/^[a-f0-9]{12}$/.test(investigationId)) return null;
  const path = join(dir, `${investigationId}.json`);
  try {
    if (!existsSync(path)) return null;
    if (statSync(path).size > EVIDENCE_FILE_MAX_BYTES) return null;
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const clean: Partial<Record<keyof InvestigationEvidence, string>> = {};
    for (const field of EVIDENCE_REQUIRED_STRING_FIELDS) {
      const value = record[field];
      if (typeof value !== "string" || value.length === 0 || value.length > EVIDENCE_FIELD_MAX_LENGTH) return null;
      const sanitized = sanitizeEvidenceField(value);
      if (sanitized.length === 0) return null;
      clean[field] = sanitized;
    }
    if (clean.investigationId !== investigationId) return null;
    return clean as InvestigationEvidence;
  } catch {
    return null;
  }
}

export function buildStartPayloadPrompt(payload: string, evidence: InvestigationEvidence | null): string {
  if (!evidence) {
    return [
      "Investigate this issue using the available local agent skills and tools.",
      `Correlation id: ${payload}`,
      "No investigation evidence record was found locally for this id (missing, expired, or unreadable).",
      "Do not treat the correlation id itself as evidence — confirm with the registered application's own status/logs before concluding anything.",
    ].join("\n");
  }
  return [
    "Investigate this issue using the available local agent skills and tools.",
    `Registered application: ${evidence.applicationName}`,
    `Workspace: ${evidence.workspaceId}`,
    `Health status: ${evidence.status}`,
    `Reason: ${evidence.reason}`,
    `Last checked: ${evidence.checkedAt}`,
    `Correlation id: ${payload}`,
  ].join("\n");
}

function startPayloadExecution(prompt: string): CommandResult | null {
  const payload = parseStartPayload(prompt);
  if (!payload) return null;
  const investigationId = extractInvestigationId(payload);
  const evidence = investigationId ? readInvestigationEvidence(investigationId) : null;
  return {
    kind: "execute",
    prompt: buildStartPayloadPrompt(payload, evidence),
  };
}

export function isBridgeCommand(text: string): boolean {
  return bridgeCommands.has(normalizeCommand(text));
}

export function antigravityNarrationSettingKey(chatId: string): string {
  return `antigravity:narration:${chatId}`;
}

export function isAntigravityNarrationVisible(db: BridgeDb, chatId: string): boolean {
  return db.getSetting(antigravityNarrationSettingKey(chatId)) === "visible";
}

function handleNarrationCommand(kind: BotKind, text: string, db: BridgeDb, chatId: string): CommandResult {
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
  kind: BotKind,
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
    db.clearConvHistory(chatId, surfaceIdentity);
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
    return { kind: "message", text: buildSkillsText() };
  }

  if (text === "/narration") {
    return handleNarrationCommand(kind, prompt, db, chatId);
  }

  if (text === "/usage") {
    if (kind !== "codex") {
      return { kind: "message", text: "/usage is only available on the Codex bridge." };
    }
    return { kind: "codex_usage" };
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
    const turnWord = status.turnCount === 1 ? "1 turn" : `${status.turnCount} turns`;
    return {
      kind: "message",
      text: [
        `**Context status** for \`${chatId}\``,
        `Stored: ${turnWord}`,
        `Pending queue: ${status.pendingCount}`,
        `Latest turn: ${status.latestTurnAt ?? "none"}`,
        "Retrieval: retained exact turns (`--recent` / `--search`)",
      ].join("\n"),
    };
  }

  if (String(prompt || "").trim().startsWith("/") && text !== "/stop" && text !== "/cancel") {
    return { kind: "execute", prompt: String(prompt || "").trim() };
  }
  return null;
}

export function buildTelegramCommands(kind: BotKind): Array<{ command: string; description: string }> {
  const commands = [
    { command: "models",   description: "Switch model" },
    { command: "effort",   description: "Switch reasoning effort" },
    { command: "queue_mode", description: "Set busy-message handling" },
    { command: "reset",    description: "Reset session and clear conversation history" },
    { command: "stop",     description: "Abort running execution" },
    { command: "context",  description: "Show context status" },
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
