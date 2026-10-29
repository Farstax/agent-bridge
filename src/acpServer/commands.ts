import * as acp from "@agentclientprotocol/sdk";
import { resolveAcpTelegramConfigCallback } from "../acp/telegramConfigCallback.js";
import { effortSettingKey, isEffortLevel, resolveDefaultEffort } from "../effort.js";
import { handleCommand, normalizeCommand } from "../commands.js";
import type { BridgeDb } from "../db.js";
import { supportsToolFreeMode } from "../providers/registry.js";
import type { OutwardAcpSessionRecord } from "../repositories/outwardAcpSessionRepository.js";
import type { BotKind, BridgeConfig, RouteableBotKind } from "../types.js";
import { OUTWARD_ACP_SURFACE, type OutwardWorkstreamControl } from "./execution.js";

/**
 * Desk command parity (#1101). Each command runs through its existing Bridge
 * owner before any model prompting; nothing here becomes prompt text.
 * Commands with a standard ACP or Workstream equivalent point at it.
 */
export type DeskCommandRoute =
  | "run"
  | "session/cancel"
  | "session/new"
  | "_agent-bridge/workstreams/status"
  | "_agent-bridge/workstreams/select_provider"
  | "_agent-bridge/commands/list";

export interface DeskCommandEntry {
  name: string;
  description: string;
  available: boolean;
  /** Why the command is unavailable for this Workstream/provider. */
  reason?: string;
  route: DeskCommandRoute;
  /** Free-text argument the command takes, if any. */
  argument?: string;
  /** Destructive: `run` requires `confirm: true`. */
  requiresConfirmation?: boolean;
  /** `run` returns `options`; pass one `token` back as `select`. */
  selectable?: boolean;
}

export interface DeskCommandOption {
  label: string;
  selected: boolean;
  token: string;
}

export interface DeskCommandResult {
  command: string;
  text: string;
  options?: DeskCommandOption[];
}

export interface DeskCommandControl extends OutwardWorkstreamControl {
  cancel(session: OutwardAcpSessionRecord): Promise<void>;
  /** Run `operation` holding the Workstream lane; throws busy when a Run holds it. */
  withIdleLane<T>(session: OutwardAcpSessionRecord, operation: () => T): T;
  btw?(session: OutwardAcpSessionRecord, provider: BotKind, prompt: string): Promise<string>;
}

export interface DeskCommandOptions {
  db: BridgeDb;
  config: BridgeConfig;
  control: DeskCommandControl;
  codexUsage?: () => Promise<string>;
}

const NOT_ON_OUTWARD = "owner/admin command; not authorised on the outward ACP surface";
const UNKNOWN_COMMAND_ERROR = "unknown Bridge command";

type Definition = Omit<DeskCommandEntry, "available" | "reason"> & {
  unavailable?: (provider: RouteableBotKind, options: DeskCommandOptions, session: OutwardAcpSessionRecord) => string | null;
};

const DEFINITIONS: readonly Definition[] = [
  { name: "start", description: "Show readiness", route: "run" },
  { name: "help", description: "List commands", route: "_agent-bridge/commands/list" },
  { name: "new", description: "Start a new Workstream", route: "session/new" },
  { name: "status", description: "Show Workstream status", route: "_agent-bridge/workstreams/status" },
  { name: "stop", description: "Abort running execution", route: "session/cancel" },
  {
    name: "reset",
    description: "Reset session and clear conversation history",
    route: "run",
    requiresConfirmation: true,
  },
  { name: "models", description: "Switch model", route: "run", selectable: true },
  { name: "effort", description: "Switch reasoning effort", route: "run", selectable: true },
  {
    name: "queue_mode",
    description: "Set busy-message handling",
    route: "run",
    unavailable: () => "outward ACP rejects a concurrent prompt as busy; there is no queue to configure",
  },
  { name: "cli", description: "Switch provider", route: "_agent-bridge/workstreams/select_provider", selectable: true },
  { name: "switch", description: "Switch provider", route: "_agent-bridge/workstreams/select_provider", selectable: true },
  { name: "context", description: "Show context status", route: "run" },
  { name: "skills", description: "List bundled skills", route: "run" },
  {
    name: "btw",
    description: "Fresh read-only side question",
    route: "run",
    argument: "prompt",
    unavailable: (provider, options) => !options.control.btw
      ? "not configured on this outward agent"
      : provider === "antigravity" || !supportsToolFreeMode(provider)
        ? `isolated read-only execution cannot be proven for ${provider}`
        : null,
  },
  {
    name: "usage",
    description: "Show Codex plan usage",
    route: "run",
    unavailable: (provider, options) => provider !== "codex"
      ? "only available on Codex"
      : !options.codexUsage ? "not configured on this outward agent" : null,
  },
  {
    name: "narration",
    description: "Toggle Agy narration visibility",
    route: "run",
    argument: "on|off|status",
    unavailable: (provider) => provider === "antigravity" ? null : "only available on Antigravity",
  },
  { name: "sensors", description: "Sensor controls", route: "run", unavailable: () => NOT_ON_OUTWARD },
  { name: "autonomy", description: "Autonomy controls", route: "run", unavailable: () => NOT_ON_OUTWARD },
];

const BY_NAME = new Map(DEFINITIONS.map((definition) => [definition.name, definition]));

/** Bridge command names a standard prompt must not silently forward to a model. */
export function isDeskBridgeCommand(promptText: string): boolean {
  const name = normalizeCommand(promptText).replace(/^\//, "");
  return promptText.trim().startsWith("/") && BY_NAME.has(name);
}

type KeyboardButton = { text: string; callback_data: string };

function keyboardOptions(markup: unknown): DeskCommandOption[] {
  const rows = (markup as { inline_keyboard?: KeyboardButton[][] } | undefined)?.inline_keyboard ?? [];
  return rows.flat().map((button) => ({
    label: button.text.replace(/^✓ /, ""),
    selected: button.text.startsWith("✓ "),
    token: button.callback_data,
  }));
}

export class DeskCommands {
  constructor(private readonly options: DeskCommandOptions) {}

  private provider(session: OutwardAcpSessionRecord): BotKind {
    return this.options.control.status(session).selectedProvider;
  }

  private providerAvailable(session: OutwardAcpSessionRecord, provider: BotKind): boolean {
    return this.options.control.status(session).providers.find((candidate) => candidate.id === provider)?.available ?? false;
  }

  catalogue(session: OutwardAcpSessionRecord): DeskCommandEntry[] {
    const provider = this.provider(session);
    return DEFINITIONS.map(({ unavailable, ...entry }) => {
      let reason = unavailable?.(provider, this.options, session) ?? null;
      const requiresProvider = ["models", "effort", "btw", "usage", "narration"].includes(entry.name);
      if (!reason && requiresProvider && !this.providerAvailable(session, provider)) {
        reason = `${provider} is not installed or authenticated`;
      }
      return reason ? { ...entry, available: false, reason } : { ...entry, available: true };
    });
  }

  async run(
    session: OutwardAcpSessionRecord,
    request: { command: string; argument?: string; select?: string; confirm?: boolean },
  ): Promise<DeskCommandResult> {
    const name = request.command.replace(/^\//, "").toLowerCase();
    const entry = this.catalogue(session).find((candidate) => candidate.name === name);
    if (!entry) throw acp.RequestError.invalidParams({ field: "command" }, UNKNOWN_COMMAND_ERROR);
    if (!entry.available) {
      throw acp.RequestError.invalidParams({ field: "command" }, `/${name} is unavailable: ${entry.reason}`);
    }
    if (request.select !== undefined && !entry.selectable) {
      throw acp.RequestError.invalidParams({ field: "select" }, `/${name} has no options`);
    }
    const provider = this.provider(session);
    const { db, config, control } = this.options;
    const legacy = (text: string) => handleCommand(provider, text, {
      db,
      chatId: session.conversationId,
      config,
      surfaceIdentity: OUTWARD_ACP_SURFACE,
    });

    switch (name) {
      case "help": {
        const lines = this.catalogue(session).map((c) => `/${c.name} - ${c.description}${c.available ? "" : ` (unavailable: ${c.reason})`}`);
        return { command: name, text: lines.join("\n") };
      }
      case "new":
        return { command: name, text: "Start a new Workstream with ACP session/new." };
      case "status": {
        const status = control.status(session);
        return { command: name, text: `State: ${status.state}. Provider: ${status.nextProvider}.` };
      }
      case "stop":
        await control.cancel(session);
        return { command: name, text: "Stop requested. Any running execution was cancelled." };
      case "reset": {
        if (request.confirm !== true) {
          throw acp.RequestError.invalidParams({ field: "confirm" }, "/reset clears history and pending work; resend with confirm: true");
        }
        // Same order as Telegram: abort the active Run, then reset under the lane.
        await control.cancel(session);
        const result = control.withIdleLane(session, () => legacy("/reset"));
        return { command: name, text: result && "text" in result ? result.text : "Session reset." };
      }
      case "cli":
      case "switch": {
        if (request.select !== undefined) {
          const status = control.selectProvider(session, request.select.replace(/^provider:/, ""));
          return { command: name, text: `Provider set to ${status.selectedProvider}.`, options: this.providerOptions(session) };
        }
        return { command: name, text: `Provider: ${control.status(session).selectedProvider}.`, options: this.providerOptions(session) };
      }
      case "models":
      case "effort":
        return this.selectSetting(session, name, provider, request.select);
      case "btw": {
        const prompt = request.argument?.trim();
        if (!prompt) throw acp.RequestError.invalidParams({ field: "argument" }, "/btw needs a prompt");
        return { command: name, text: await control.btw!(session, provider as BotKind, prompt) };
      }
      case "usage":
        return { command: name, text: await this.options.codexUsage!() };
      case "narration": {
        const result = legacy(`/narration ${request.argument ?? "status"}`.trim());
        return { command: name, text: result && "text" in result ? result.text : "" };
      }
      default: {
        // start, context, skills: read-only owners returning plain text.
        const result = legacy(`/${name}`);
        if (!result || result.kind !== "message") {
          throw acp.RequestError.invalidParams({ field: "command" }, `/${name} has no outward ACP result`);
        }
        return { command: name, text: result.text };
      }
    }
  }

  private providerOptions(session: OutwardAcpSessionRecord): DeskCommandOption[] {
    const status = this.options.control.status(session);
    return status.providers.filter((p) => p.available).map((p) => ({
      label: p.id,
      selected: p.id === status.selectedProvider,
      token: `provider:${p.id}`,
    }));
  }

  /**
   * Model/effort use the existing per-provider settings owners. A selection
   * must be one of the options currently offered; ACP values resolve against
   * the live provider catalogue exactly as Telegram buttons do.
   */
  private selectSetting(
    session: OutwardAcpSessionRecord,
    name: "models" | "effort",
    provider: RouteableBotKind,
    select: string | undefined,
  ): DeskCommandResult {
    const { db, config } = this.options;
    const view = () => {
      const result = handleCommand(provider, `/${name}`, { db, chatId: session.conversationId, config, surfaceIdentity: OUTWARD_ACP_SURFACE });
      if (!result || result.kind !== "keyboard_message") throw new Error(`/${name} returned no options`);
      return { command: name, text: result.text, options: keyboardOptions(result.reply_markup) };
    };
    if (select === undefined) return view();
    if (!view().options.some((option) => option.token === select)) {
      throw acp.RequestError.invalidParams({ field: "select" }, "option is no longer offered; list the command again");
    }
    applySettingSelection(db, provider, name, select);
    return view();
  }
}

function applySettingSelection(db: BridgeDb, provider: RouteableBotKind, name: "models" | "effort", token: string): void {
  const acpSelection = resolveAcpTelegramConfigCallback(token);
  if (acpSelection) {
    if (acpSelection.providerId !== provider || (!acpSelection.useProviderDefault && acpSelection.value === null)) {
      throw acp.RequestError.invalidParams({ field: "select" }, "option is no longer offered; list the command again");
    }
    const next = acpSelection.useProviderDefault ? null : acpSelection.value!;
    db.setSetting(acpSelection.category === "thought_level" ? effortSettingKey(provider) : provider, next);
    return;
  }
  const [action, kind, ...rest] = token.split(":");
  const value = rest.join(":");
  if (kind !== provider) throw acp.RequestError.invalidParams({ field: "select" }, "option belongs to another provider");
  if (name === "effort" && action === "effort") {
    const next = value === "reset" ? resolveDefaultEffort(provider) : value;
    if (!isEffortLevel(next)) throw acp.RequestError.invalidParams({ field: "select" }, "unsupported effort");
    db.setSetting(effortSettingKey(provider), value === "reset" ? null : next);
    return;
  }
  if (name === "models" && action === "model") {
    db.setSetting(provider, value === "reset" ? null : value);
    return;
  }
  throw acp.RequestError.invalidParams({ field: "select" }, "option does not match the command");
}
