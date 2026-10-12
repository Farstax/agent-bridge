/**
 * PURPOSE: Receipt-driven admission, one-shot dispatch and restart recovery for
 * Slack events (#943). The only execution it triggers is the injected
 * `dispatch`, which is the existing provider-fallback dispatch; this module owns
 * no execution, queue or delivery logic.
 * INPUTS: authenticated events_api envelopes, durable receipts.
 * OUTPUTS: acknowledgements (after durable admission), terminal receipt states.
 * NEIGHBORS: src/slackIngress.ts, src/index-slack-interactive.ts
 */
import type { BridgeDb, EventReceipt } from "./db.js";
import { EVENT_RECEIPT_CORRELATION_PREFIX, type InteractiveTurnInput } from "./interactiveIngress.js";
import {
  SLACK_RECEIPT_SOURCE,
  admitSlackTurn,
  classifySlackEnvelope,
  turnFromReceipt,
  type SlackVerifiedContext,
} from "./slackIngress.js";

export const SLACK_RESTART_NOTICE = "Agent Bridge restarted while handling this message and could not confirm it finished. It was not re-run. Send it again if you still need it.";
export const SLACK_AMBIGUOUS_NOTICE = "This message may not have completed. It was not re-run. Send it again if you still need it.";
export const MAX_RESTART_NOTICES = 20;

export interface SlackReceiptRuntimeDeps {
  db: BridgeDb;
  context: SlackVerifiedContext;
  authorityScope: string;
  /** Existing provider-fallback dispatch for one normalised turn. */
  dispatch: (turn: InteractiveTurnInput) => Promise<unknown>;
  /** Native-coordinate notice (channel, thread ts). */
  notify: (channel: string, thread: string | undefined, text: string) => Promise<void>;
  log?: (message: string) => void;
  onAdmissionDegraded?: (reason: "storage" | "backlog") => void;
}

export interface SlackEnvelopeArgs {
  ack: (response?: Record<string, unknown>) => Promise<void>;
  body: any;
}

export function createSlackReceiptRuntime(deps: SlackReceiptRuntimeDeps) {
  const { db, context, authorityScope } = deps;
  const log = deps.log ?? (() => undefined);
  /** Startup recovery gates live dispatch so no turn races reconciliation. */
  let ready: Promise<void> = Promise.resolve();

  async function dispatchReceipt(receipt: EventReceipt, stored: InteractiveTurnInput): Promise<void> {
    // Exactly one claimant may execute a receipt.
    if (!db.claimEventReceiptDispatch(receipt.id)) return;
    const turn: InteractiveTurnInput = { ...stored, scheduledOccurrenceKey: `${EVENT_RECEIPT_CORRELATION_PREFIX}${receipt.id}` };
    try {
      await deps.dispatch(turn);
      const linked = db.getEventReceipt(receipt.id);
      db.finishEventReceipt(receipt.id, { status: "completed", result_reference: linked?.run_id ?? null });
    } catch (error) {
      // The provider may already have started: fence, never replay.
      db.finishEventReceipt(receipt.id, { status: "ambiguous", error_class: "dispatch_failed" });
      log(`dispatch failed receipt=${receipt.id} ${error instanceof Error ? error.name : "error"}`);
      await deps.notify(String(turn.delivery.chatId), turn.threadId, SLACK_AMBIGUOUS_NOTICE).catch(() => undefined);
    }
  }

  async function handleEnvelope(args: SlackEnvelopeArgs): Promise<void> {
    const decision = classifySlackEnvelope(args.body, context);
    if (decision.kind === "ignore") {
      log(`event.ignored reason=${decision.reason}`);
      await args.ack().catch(() => undefined);
      return;
    }
    let admission;
    try {
      admission = admitSlackTurn(db, decision, authorityScope);
    } catch {
      // No durable intent exists, so the envelope must not be acknowledged.
      deps.onAdmissionDegraded?.("storage");
      log("admission failed; envelope not acknowledged");
      return;
    }
    if (admission.kind === "backlog_full") {
      deps.onAdmissionDegraded?.("backlog");
      log("undispatched backlog full; envelope not acknowledged");
      return;
    }
    await args.ack().catch(() => log("acknowledgement failed; the durable receipt is retained"));
    if (admission.kind === "duplicate") return;
    await ready;
    await dispatchReceipt(admission.receipt, admission.turn);
  }

  /** Restart reconciliation: fence possibly-started work, run never-started work once. */
  async function recoverReceipts(): Promise<void> {
    let notices = 0;
    for (const receipt of db.listEventReceipts(SLACK_RECEIPT_SOURCE, ["dispatching", "run_created"])) {
      const run = receipt.run_id ? db.getRun(receipt.run_id) : null;
      if (run && run.status === "done") {
        db.finishEventReceipt(receipt.id, { status: "completed", result_reference: receipt.run_id });
        continue;
      }
      db.finishEventReceipt(receipt.id, { status: "ambiguous", result_reference: receipt.run_id, error_class: "restart_interrupted" });
      const stored = turnFromReceipt(receipt);
      if (stored && notices < MAX_RESTART_NOTICES) {
        notices += 1;
        await deps.notify(String(stored.delivery.chatId), stored.threadId, SLACK_RESTART_NOTICE).catch(() => undefined);
      }
    }
    const redispatch: Promise<void>[] = [];
    for (const receipt of db.listEventReceipts(SLACK_RECEIPT_SOURCE, ["received"])) {
      const stored = turnFromReceipt(receipt);
      if (!stored) {
        if (db.claimEventReceiptDispatch(receipt.id)) db.finishEventReceipt(receipt.id, { status: "failed", error_class: "payload_invalid" });
        continue;
      }
      redispatch.push(dispatchReceipt(receipt, stored));
    }
    await Promise.all(redispatch);
  }

  return {
    handleEnvelope,
    recoverReceipts,
    /** Hold live dispatch until the given startup recovery has settled. */
    gateOn(promise: Promise<void>) { ready = promise.catch(() => undefined); },
  };
}
