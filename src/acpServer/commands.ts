import * as acp from "@agentclientprotocol/sdk/unstable";
import { resolveAcpTelegramConfigCallback } from "../acp/telegramConfigCallback.js";
import { applyEffortSelection, storeEffortPreference } from "../effort.js";
import { applyModelSelection } from "../bridge.js";
import { handleCommand, normalizeCommand } from "../commands.js";
import { buildBusyMessageModeKeyboard, isBusyMessageModeSelection, resolveLaneBusyMessageMode, setLaneBusyMessageMode } from "../busyMessageMode.js";
import type { BridgeDb } from "../db.js";
import { supportsToolFreeMode } from "../providers/registry.js";
import type { OutwardAcpSessionRecord } from "../repositories/outwardAcpSessionRepository.js";
import type { BotKind, BridgeConfig, RouteableBotKind } from "../types.js";
import { OUTWARD_ACP_SURFACE, type OutwardWorkstreamControl } from "./execution.js";

/**
 * Optional ACP commands use existing Bridge owners. Commands with a standard
 * ACP or workstream equivalent point at it.
 */
export type AcpCommandRoute =
  | "run"
  | "session/cancel"
  | "session/new"
  | "_agent-bridge/workstreams/status"
  | "_agent-bridge/workstreams/select_provider"
  | "_agent-bridge/commands/list";

export interface AcpCommandEntry {
  name: string;
  description: string;
  available: boolean;
  /** Why the command is unavailable for this Workstream/provider. */
  reason?: string;
  route: AcpCommandRoute;
  /** Free-text argument the command takes, if any. */
  argument?: string;
  /** Destructive: `run` requires `confirm: true`. */
  requiresConfirmation?: boolean;
  /** `run` returns `options`; pass one `token` back as `select`. */
  selectable?: boolean;
}

export interface AcpCommandOption {
  label: string;
  selected: boolean;
  token: string;
}

export interface AcpCommandResult {
  command: string;
  text: string;
  options?: AcpCommandOption[];
}

export interface AcpCommandControl extends OutwardWorkstreamControl {
  cancel(session: OutwardAcpSessionRecord): Promise<void>;
  /** Run `operation` holding the Workstream lane; throws busy when a Run holds it. */
  withIdleLane<T>(session: OutwardAcpSessionRecord, operation: () => T): T;
  btw?(session: OutwardAcpSessionRecord, provider: BotKind, prompt: string): Promise<string>;
  readonly supportsBusyMessages?: boolean;
}

export interface AcpCommandOptions {
  db: BridgeDb;
  config: BridgeConfig;
  control: AcpCommandControl;
  codexUsage?: () => Promise<string>;
}

const NOT_ON_OUTWARD = "owner/admin command; not authorised on the outward ACP surface";
const UNKNOWN_COMMAND_ERROR = "unknown Bridge command";

type Definition = Omit<AcpCommandEntry, "available" | "reason"> & {
  unavailable?: (provider: RouteableBotKind, options: AcpCommandOptions, session: OutwardAcpSessionRecord) => string | null;
};

const DEFINITIONS: readonly Definition[] = [
  { name: "start", description: "Show readiness", route: "run" },
  { name: "help", description: "List commands", route: "_agent-bridge/commands/list" },
  { name: "new", description: "Create a session", route: "session/new" },
  { name: "status", description: "Show session status", route: "_agent-bridge/workstreams/status" },
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
    selectable: true,
    unavailable: (_provider, options) => options.control.supportsBusyMessages
      ? null
      : "this outward agent does not offer busy-message handling",
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

type KeyboardButton = { text: string; callback_data: string };

function keyboardOptions(markup: unknown): AcpCommandOption[] {
  const rows = (markup as { inline_keyboard?: KeyboardButton[][] } | undefined)?.inline_keyboard ?? [];
  return rows.flat().map((button) => ({
    label: button.text.replace(/^✓ /, ""),
    selected: button.text.startsWith("✓ "),
    token: button.callback_data,
  }));
}

export class AcpCommands {
  constructor(private readonly options: AcpCommandOptions) {}

  private provider(session: OutwardAcpSessionRecord): BotKind {
    return this.options.control.status(session).selectedProvider;
  }

  catalogue(session: OutwardAcpSessionRecord): AcpCommandEntry[] {
    const status = this.options.control.status(session);
    const provider = status.selectedProvider;
    return DEFINITIONS.map(({ unavailable, ...entry }) => {
      let reason = unavailable?.(provider, this.options, session) ?? null;
      const requiresProvider = ["models", "effort", "btw", "usage", "narration"].includes(entry.name);
      if (!reason && requiresProvider && !(status.providers.find((candidate) => candidate.id === provider)?.available ?? false)) {
        reason = `${provider} is not installed or authenticated`;
      }
      return reason ? { ...entry, available: false, reason } : { ...entry, available: true };
    });
  }

  async run(
    session: OutwardAcpSessionRecord,
    request: { command: string; argument?: string; select?: string; confirm?: boolean },
  ): Promise<AcpCommandResult> {
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
        return { command: name, text: "Create a new session with session/new." };
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
      case "queue_mode":
        return this.selectBusyMode(session, request.select);
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
        const mode = request.argument?.trim().toLowerCase() || "status";
        const render = () => {
          const result = legacy(`/narration ${mode}`);
          return { command: name, text: result && "text" in result ? result.text : "" };
        };
        return mode === "status" ? render() : control.withIdleLane(session, render);
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

  /**
   * Busy-message mode is the shared lane setting every adapter reads. It only
   * governs clients that opt into busy-message admission; legacy ACP v1 clients
   * still fail fast. It is a plain setting, valid while the lane is busy.
   */
  private selectBusyMode(session: OutwardAcpSessionRecord, select: string | undefined): AcpCommandResult {
    const { db } = this.options;
    if (select !== undefined) {
      const value = select.replace(/^queue_mode:/, "");
      if (!isBusyMessageModeSelection(value)) {
        throw acp.RequestError.invalidParams({ field: "select" }, "unsupported busy-message mode");
      }
      setLaneBusyMessageMode(db, OUTWARD_ACP_SURFACE, session.conversationId, value, "queue");
    }
    const active = resolveLaneBusyMessageMode(db, OUTWARD_ACP_SURFACE, session.conversationId, "queue");
    return {
      command: "queue_mode",
      text: `Busy-message mode: ${active}. This applies to messages from clients that opted into busy-message handling.`,
      options: keyboardOptions(buildBusyMessageModeKeyboard(active)),
    };
  }

  private providerOptions(session: OutwardAcpSessionRecord): AcpCommandOption[] {
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
  ): AcpCommandResult {
    const { db, config } = this.options;
    const view = () => {
      const result = handleCommand(provider, `/${name}`, { db, chatId: session.conversationId, config, surfaceIdentity: OUTWARD_ACP_SURFACE });
      if (!result || result.kind !== "keyboard_message") throw new Error(`/${name} returned no options`);
      return { command: name, text: result.text, options: keyboardOptions(result.reply_markup) };
    };
    if (select === undefined) return view();
    // Validate and mutate under the existing Run lane; never change settings
    // midway through an active prompt or while the offered options change.
    return this.options.control.withIdleLane(session, () => {
      if (!view().options.some((option) => option.token === select)) {
        throw acp.RequestError.invalidParams({ field: "select" }, "option is no longer offered; list the command again");
      }
      applySettingSelection(db, provider, name, select);
      return view();
    });
  }
}

function applySettingSelection(db: BridgeDb, provider: RouteableBotKind, name: "models" | "effort", token: string): void {
  const acpSelection = resolveAcpTelegramConfigCallback(token);
  if (acpSelection) {
    if (acpSelection.providerId !== provider || (!acpSelection.useProviderDefault && acpSelection.value === null)) {
      throw acp.RequestError.invalidParams({ field: "select" }, "option is no longer offered; list the command again");
    }
    const next = acpSelection.useProviderDefault ? null : acpSelection.value!;
    if (acpSelection.category === "thought_level") storeEffortPreference(db, provider, next);
    else applyModelSelection(db, provider, next);
    return;
  }
  const [action, kind, ...rest] = token.split(":");
  const value = rest.join(":");
  if (kind !== provider) throw acp.RequestError.invalidParams({ field: "select" }, "option belongs to another provider");
  if (name === "effort" && action === "effort") {
    if (!applyEffortSelection(db, provider, value)) throw acp.RequestError.invalidParams({ field: "select" }, "unsupported effort");
    return;
  }
  if (name === "models" && action === "model") {
    applyModelSelection(db, provider, value);
    return;
  }
  throw acp.RequestError.invalidParams({ field: "select" }, "option does not match the command");
}
