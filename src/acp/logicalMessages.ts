import type { SessionUpdate } from "@agentclientprotocol/sdk";

/**
 * Provider-neutral reconstruction of ACP assistant text into logical messages.
 *
 * Boundaries come only from protocol evidence: a changed non-empty
 * `messageId`, a structural event (tool call/update, thought chunk) between two
 * visible text runs of an id-less adapter, or a caller-supplied group change
 * (for example a provider phase). Punctuation, capitalisation and timing are
 * never consulted, so adjacent id-less fragments stay byte-identical.
 *
 * This is presentation only. Raw ACP protocol chunks are never rewritten with
 * the paragraph separator.
 */
export const ACP_MESSAGE_SEPARATOR = "\n\n";

export type AcpBoundaryReason = "message-id-change" | "structural-event" | "group-change";

export interface AcpLogicalMessage {
  text: string;
  messageId?: string;
  group?: string;
  boundaryReason?: AcpBoundaryReason;
}

export interface AcpTextFragment {
  /** Text exactly as received. */
  readonly text: string;
  /** Index of the logical message this fragment belongs to. */
  readonly messageIndex: number;
  /** True for the first fragment of a logical message. */
  readonly startsMessage: boolean;
  readonly group?: string;
}

export interface AcpLogicalMessageOptions {
  /** Optional provider-owned grouping key; a change between text runs is a boundary. */
  readonly groupOf?: (update: SessionUpdate) => string | undefined;
}

const STRUCTURAL_UPDATES: ReadonlySet<string> = new Set([
  "tool_call",
  "tool_call_update",
  "agent_thought_chunk",
]);

function messageIdOf(update: SessionUpdate): string | undefined {
  const id = (update as { messageId?: unknown }).messageId;
  return typeof id === "string" && id !== "" ? id : undefined;
}

export class AcpLogicalMessageReconstructor {
  readonly messages: AcpLogicalMessage[] = [];
  private structuralSinceText = false;

  constructor(private readonly options: AcpLogicalMessageOptions = {}) {}

  /** Feed every relevant update in order. Returns the visible text fragment, if any. */
  observe(update: SessionUpdate): AcpTextFragment | null {
    if (STRUCTURAL_UPDATES.has(update.sessionUpdate)) {
      this.structuralSinceText = true;
      return null;
    }
    if (update.sessionUpdate !== "agent_message_chunk" || update.content.type !== "text") return null;
    const text = update.content.text;
    if (text === "") return null;

    const id = messageIdOf(update);
    const group = this.options.groupOf?.(update);
    const active = this.messages[this.messages.length - 1];
    let reason: AcpBoundaryReason | undefined;
    let startsMessage = active === undefined;

    if (active) {
      if (id && active.messageId && id !== active.messageId) reason = "message-id-change";
      else if (group !== active.group) reason = "group-change";
      else if (!(id && active.messageId) && this.structuralSinceText) reason = "structural-event";
      startsMessage = reason !== undefined;
    }
    this.structuralSinceText = false;

    if (startsMessage) {
      this.messages.push({
        text,
        ...(id ? { messageId: id } : {}),
        ...(group !== undefined ? { group } : {}),
        ...(reason ? { boundaryReason: reason } : {}),
      });
    } else {
      active!.text += text;
      if (id && !active!.messageId) active!.messageId = id;
    }
    return { text, messageIndex: this.messages.length - 1, startsMessage, ...(group !== undefined ? { group } : {}) };
  }
}

export function renderLogicalMessages(messages: readonly AcpLogicalMessage[]): string {
  return messages.map((message) => message.text).join(ACP_MESSAGE_SEPARATOR);
}

export function reconstructLogicalMessages(
  updates: Iterable<SessionUpdate>,
  options: AcpLogicalMessageOptions = {},
): AcpLogicalMessage[] {
  const reconstructor = new AcpLogicalMessageReconstructor(options);
  for (const update of updates) reconstructor.observe(update);
  return reconstructor.messages;
}

/**
 * Live-preview adapter: yields the text to append for each fragment, prefixed
 * with the separator when a new logical message starts after earlier output.
 * `accept` lets a provider hide groups (e.g. commentary) without hiding their
 * boundary evidence from reconstruction.
 */
export function createLogicalPreviewTextStream(
  options: AcpLogicalMessageOptions & { readonly accept?: (fragment: AcpTextFragment) => boolean } = {},
): (update: SessionUpdate) => string {
  const reconstructor = new AcpLogicalMessageReconstructor(options);
  let emittedAny = false;
  let lastEmittedMessage = -1;
  return (update) => {
    const fragment = reconstructor.observe(update);
    if (!fragment || (options.accept && !options.accept(fragment))) return "";
    const separate = emittedAny && fragment.messageIndex !== lastEmittedMessage;
    emittedAny = true;
    lastEmittedMessage = fragment.messageIndex;
    return separate ? ACP_MESSAGE_SEPARATOR + fragment.text : fragment.text;
  };
}
