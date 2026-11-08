/**
 * Durable outward ACP capacity recovery (#1114).
 * This process owns the existing RunContinuationRunner for acp:outward; it
 * neither opens an ACP server nor relies on a browser or pooled stdio client.
 */
import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { openProductionDb, type BridgeDb } from "../db.js";
import { RunContinuationRunner, buildRunContinuationInstruction, listRunContinuations, type RunContinuation } from "../runContinuation.js";
import { lookupProviderSession } from "../providers/sessionRuntime.js";
import { outwardServiceId, recoverOutwardLanes } from "./recovery.js";
import { prepareInteractiveCliAuth } from "../interactiveCliAuth.js";
import { OutwardAcpSessionRepository, type OutwardAcpSessionRecord } from "../repositories/outwardAcpSessionRepository.js";
import { readRetainedOutwardAcpAttachments, releaseRetainedOutwardAcpAttachments } from "./attachments.js";
import {
  OUTWARD_ACP_SURFACE,
  OutwardCapacityRetry,
  type OutwardAcpPromptExecutor,
  createProductionOutwardAcpPromptExecutor,
} from "./execution.js";

/** A real, separately owned successor Run is the only proof of completion. */
export async function resumeOutwardCapacityWait(
  db: BridgeDb,
  lookup: (id: string) => OutwardAcpSessionRecord | null,
  executor: OutwardAcpPromptExecutor,
  wait: RunContinuation,
): Promise<boolean> {
  if (!wait.capacityWait || !wait.outward || !wait.claimToken ||
      wait.state !== "claimed" || wait.surfaceIdentity !== OUTWARD_ACP_SURFACE) {
    throw new Error("outward capacity continuation is not an authorised claimed wait");
  }
  const session = lookup(wait.outward.sessionId);
  if (!session || session.conversationId !== wait.chatKey) throw new Error("outward capacity session identity changed");
  const cwd = await realpath(session.cwd);
  if (!isAbsolute(cwd) || cwd !== session.cwd) {
    throw new Error("outward capacity workspace path is invalid");
  }
  const retained = await readRetainedOutwardAcpAttachments(cwd, wait.id);
  if (retained.length !== wait.outward.attachmentCount) throw new Error("outward capacity attachments changed");
  try {
    const result = await executor.execute({
      session,
      prompt: wait.outward.prompt,
      attachments: retained,
      signal: new AbortController().signal,
      onUpdate: () => undefined,
      capacityResume: { id: wait.id, claimToken: wait.claimToken },
      ordinaryContinuations: wait.outward.ordinaryContinuations === true,
    });
    if (result.stopReason !== "end_turn") throw new Error("outward capacity successor did not complete");
    return true;
  } catch (error) {
    if (error instanceof OutwardCapacityRetry) return false;
    throw error;
  }
}

/** Execute a claimed ordinary wake through the same supervised worker, without
 * ACP stdio or a second lifecycle. No original side-effecting prompt is replayed. */
export async function resumeOutwardOrdinaryContinuation(
  db: BridgeDb,
  lookup: (id: string) => OutwardAcpSessionRecord | null,
  executor: OutwardAcpPromptExecutor,
  wake: RunContinuation,
): Promise<boolean | "queued"> {
  if (wake.capacityWait || !wake.outwardSessionId || !wake.claimToken ||
      wake.state !== "claimed" || wake.surfaceIdentity !== OUTWARD_ACP_SURFACE ||
      wake.provider === "custom-acp") {
    throw new Error("outward ordinary continuation is not an authorised claimed wake");
  }
  const session = lookup(wake.outwardSessionId);
  if (!session || session.conversationId !== wake.chatKey) {
    throw new Error("outward ordinary Workstream identity changed");
  }
  const cwd = await realpath(session.cwd);
  if (!isAbsolute(cwd) || cwd !== session.cwd) {
    throw new Error("outward ordinary workspace path is invalid");
  }
  const origin = db.getRun(wake.originRunId);
  const providerSessionId = lookupProviderSession(db,
    { surfaceIdentity: OUTWARD_ACP_SURFACE, chatKey: wake.chatKey }, wake.provider);
  if (!origin || origin.status !== "done" || !origin.session_id ||
      origin.surface_identity !== OUTWARD_ACP_SURFACE || origin.chat_id !== wake.chatKey ||
      origin.bot !== wake.provider || providerSessionId !== origin.session_id) {
    throw new Error("outward ordinary continuation provider-session authority changed");
  }
  const result = await executor.execute({
    session,
    prompt: buildRunContinuationInstruction(wake),
    signal: new AbortController().signal,
    onUpdate: () => undefined,
    ordinaryResume: {
      id: wake.id, claimToken: wake.claimToken, provider: wake.provider,
      providerSessionId,
    },
    // A busy Workstream is admitted to the existing durable Core queue;
    // its correlation is the same claimed continuation, not a fresh user Run.
    busyMessages: true,
  });
  const responseMeta = (result._meta as Record<string, unknown> | undefined)?.["agent-bridge"];
  if (responseMeta && typeof responseMeta === "object" &&
      ["queued", "running"].includes(String((responseMeta as { outcome?: unknown }).outcome))) return "queued";
  // ACP end_turn alone cannot prove durable Run/outcome settlement.
  const current = listRunContinuations(db, OUTWARD_ACP_SURFACE).find((item) => item.id === wake.id);
  const successor = current?.successorRunId ? db.getRun(current.successorRunId) : null;
  if (result.stopReason !== "end_turn" || !current || current.claimToken !== wake.claimToken ||
      current.state !== "claimed" || !successor || successor.status !== "done" ||
      successor.surface_identity !== OUTWARD_ACP_SURFACE || successor.chat_id !== wake.chatKey ||
      !successor.outcome_status) {
    throw new Error("outward ordinary continuation successor was not durably settled");
  }
  return true;
}

/** Read-only, claim-fenced evidence required before retiring retained inputs. */
export function outwardCapacityCompletionProven(db: BridgeDb, wait: RunContinuation): boolean {
  const current = listRunContinuations(db, OUTWARD_ACP_SURFACE).find((item) => item.id === wait.id);
  const successor = current?.successorRunId ? db.getRun(current.successorRunId) : null;
  return Boolean(current && current.state === "claimed" &&
    current.claimToken === wait.claimToken && successor &&
    successor.status === "done" && successor.chat_id === wait.chatKey &&
    successor.surface_identity === OUTWARD_ACP_SURFACE);
}

/**
 * Running outward Runs, held outward lane locks and queued lanes; empty means
 * there is nothing to reconcile or drain. A lock without a Run (a crash between
 * acquiring it and starting the Run, or between finishing and releasing it)
 * is evidence too, because recovery is what releases it.
 */
export function outwardRecoveryEvidence(db: BridgeDb): string {
  const running = db.listRunningRuns(OUTWARD_ACP_SURFACE).map((run) => run.run_id).sort().join(",");
  const locks = (db.raw.prepare("SELECT chat_key || '@' || acquisition_id AS id FROM execution_locks WHERE surface = ? ORDER BY chat_key")
    .all(OUTWARD_ACP_SURFACE) as Array<{ id: string }>).map((row) => row.id).join(",");
  const queued = db.pendingMessageCounts(OUTWARD_ACP_SURFACE).size;
  return running || locks || queued > 0 ? `${running}|${locks}|${queued}` : "";
}

/**
 * Bounds how often the worker repeats a full reconciliation (a process-table
 * scan for any lane it cannot yet prove absent). New evidence reconciles at
 * once; unchanged evidence backs off from one tick to about a minute, so a
 * stuck stale owner is still re-examined but never every five seconds.
 */
export class OutwardRecoveryGate {
  private last = "";
  private skipped = 0;
  private wait = 0;
  constructor(private readonly maxSkippedTicks = 11) {}

  shouldReconcile(evidence: string): boolean {
    if (evidence === "") { this.last = ""; this.skipped = 0; this.wait = 0; return false; }
    if (evidence !== this.last) { this.last = evidence; this.skipped = 0; this.wait = 0; return true; }
    if (this.skipped < this.wait) { this.skipped += 1; return false; }
    this.skipped = 0;
    this.wait = Math.min(this.wait === 0 ? 1 : this.wait * 2, this.maxSkippedTicks);
    return true;
  }
}

async function main(): Promise<void> {
  const dbPath = process.env.DB_PATH;
  if (!dbPath || !dbPath.startsWith("/") || !dbPath.endsWith(".sqlite")) {
    throw new Error("outward capacity worker requires the installed interactive DB_PATH");
  }
  const db = openProductionDb(dbPath, {
    serviceId: outwardServiceId(),
    installationId: process.env.AGENT_BRIDGE_INSTALLATION_ID,
    requireInstallationIdentity: process.env.NODE_ENV === "production" && Boolean(process.env.AGENT_BRIDGE_INSTALLATION_ID?.trim()),
    databaseRole: "interactive",
  });
  // Use the same process-identity / containment-aware recovery policy as
  // the outward ACP stdio server; do not independently release live lanes.
  await recoverOutwardLanes(db);
  try { await prepareInteractiveCliAuth(process.env); }
  catch (error) { console.error("[acp:outward:continuations] API-key verification failed", error); }
  const repository = new OutwardAcpSessionRepository(db.raw);
  const executor = createProductionOutwardAcpPromptExecutor(db, dbPath, process.env, (id) => repository.get(id));
  const runner = new RunContinuationRunner(db, OUTWARD_ACP_SURFACE, async (wait) => {
    try {
      const outcome = wait.outwardSessionId
        ? await resumeOutwardOrdinaryContinuation(db, (id) => repository.get(id), executor, wait)
        : await resumeOutwardCapacityWait(db, (id) => repository.get(id), executor, wait);
      if (outcome && wait.capacityWait) {
        // An ACP end_turn cannot alone prove that the Run/events committed.
        if (!outwardCapacityCompletionProven(db, wait)) {
          throw new Error("outward capacity successor completion is not durably proven");
        }
        await releaseRetainedOutwardAcpAttachments(repository.get(wait.outward!.sessionId)!.cwd, wait.id);
      }
      return outcome;
    } catch (error) {
      // An ambiguous or failed wake needs its original admitted attachments
      // for inspection. Expiry/cancellation owns final cleanup; never discard
      // inputs as an exception side effect.
      throw error;
    }
  }, undefined, {
    onCapacityExpired: async (wait) => {
      const session = wait.outward ? repository.get(wait.outward.sessionId) : null;
      if (session) await releaseRetainedOutwardAcpAttachments(session.cwd, wait.id);
    },
  });
  runner.start();
  // Accepted busy-message work must progress when no ACP client is connected.
  // The lane lock and row claim keep this safe against any live ACP process.
  const gate = new OutwardRecoveryGate();
  let ticking = false;
  const drainTimer = setInterval(() => {
    if (ticking) { console.warn("[acp:outward:continuations] previous recovery/drain tick is still running"); return; }
    ticking = true;
    void (async () => {
      // Cheap durable evidence decides whether a full Run/lock/process
      // reconciliation can find anything; the drain itself is one indexed read.
      const evidence = outwardRecoveryEvidence(db);
      if (gate.shouldReconcile(evidence)) await recoverOutwardLanes(db);
      await executor.drainAllQueued();
    })()
      .catch((error) => console.error("[acp:outward:continuations] queue drain failed", error))
      .finally(() => { ticking = false; });
  }, 5_000);
  // Keep the drain timer referenced: this systemd worker must remain alive
  // even when there are no pending continuations or other active handles.
  const shutdown = async () => {
    clearInterval(drainTimer);
    runner.stop();
    await executor.shutdown();
    db.close();
  };
  process.once("SIGINT", () => { void shutdown().then(() => process.exit(0)); });
  process.once("SIGTERM", () => { void shutdown().then(() => process.exit(0)); });
}

if (process.argv[1]?.endsWith("continuationWorker.ts")) {
  main().catch((error) => { console.error("[acp:outward:continuations] fatal", error); process.exitCode = 1; });
}
