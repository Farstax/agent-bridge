/**
 * Durable outward ACP capacity recovery (#1114).
 * This process owns the existing RunContinuationRunner for acp:outward; it
 * neither opens an ACP server nor relies on a browser or pooled stdio client.
 */
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { openProductionDb, type BridgeDb } from "../db.js";
import { RunContinuationRunner, type RunContinuation } from "../runContinuation.js";
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
  if (!isAbsolute(cwd) || relative(cwd, session.cwd).startsWith(`..${sep}`)) {
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
    });
    if (result.stopReason !== "end_turn") throw new Error("outward capacity successor did not complete");
    return true;
  } catch (error) {
    if (error instanceof OutwardCapacityRetry) return false;
    throw error;
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
  const executor = createProductionOutwardAcpPromptExecutor(db, dbPath, process.env);
  const runner = new RunContinuationRunner(db, OUTWARD_ACP_SURFACE, async (wait) => {
    try {
      const outcome = await resumeOutwardCapacityWait(db, (id) => repository.get(id), executor, wait);
      if (outcome) {
        // The claimed successor is durably complete. scanRunContinuations
        // settles the wait by checking Run evidence, independent of this
        // callback's boolean; cleanup may be replayed safely after restart.
        await releaseRetainedOutwardAcpAttachments(repository.get(wait.outward!.sessionId)!.cwd, wait.id);
      }
      return outcome;
    } catch (error) {
      const session = wait.outward ? repository.get(wait.outward.sessionId) : null;
      if (session) await releaseRetainedOutwardAcpAttachments(session.cwd, wait.id);
      throw error;
    }
  }, undefined, {
    onCapacityExpired: async (wait) => {
      const session = wait.outward ? repository.get(wait.outward.sessionId) : null;
      if (session) await releaseRetainedOutwardAcpAttachments(session.cwd, wait.id);
    },
  });
  runner.start();
  const shutdown = async () => {
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
