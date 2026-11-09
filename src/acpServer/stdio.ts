#!/usr/bin/env node

import * as acp from "@agentclientprotocol/sdk/unstable";
import { Readable, Writable } from "node:stream";
import { realpathSync } from "node:fs";
import { openProductionDb } from "../db.js";
import { OutwardAcpSessionRepository } from "../repositories/outwardAcpSessionRepository.js";
import { createOutwardAcpAgent, type OutwardAcpSessionStore } from "./app.js";
import { prepareInteractiveCliAuth } from "../interactiveCliAuth.js";
import { getCodexUsageText } from "../codexUsage.js";
import { outwardServiceId, recoverOutwardLanes } from "./recovery.js";
import { AcpCommands } from "./commands.js";
import { SensorRegistry } from "../sensors/registry.js";
import { prepareInteractiveAcpConfigControl } from "../interactiveAcpConfig.js";
import { resolveExecutionMode } from "../config.js";
import {
  OUTWARD_ACP_SURFACE,
  type BridgeOutwardAcpPromptExecutor,
  createProductionOutwardAcpPromptExecutor,
  outwardCommandConfig,
} from "./execution.js";

const OUTWARD_ACP_HISTORY_LIMIT = 200;

// stdout is the ACP wire. Bridge/provider diagnostics must never corrupt NDJSON.
console.log = (...args: unknown[]) => console.error(...args);
console.info = (...args: unknown[]) => console.error(...args);

// Independent Workstreams share one Git worktree lock. Report a held worktree as
// busy after a short bound instead of waiting silently behind another Run.
process.env.BRIDGE_WORKSPACE_LOCK_WAIT_SECONDS ??= "5";

const bridgeProjectDir = process.env.BRIDGE_PROJECT_DIR || process.cwd();
const workspaceRoot = realpathSync(process.env.BRIDGE_ACP_WORKSPACE_ROOT || bridgeProjectDir);
const dbPath = process.env.DB_PATH || `${bridgeProjectDir}/.data/bridge.sqlite`;
const db = openProductionDb(dbPath, {
  serviceId: outwardServiceId(),
  installationId: process.env.AGENT_BRIDGE_INSTALLATION_ID,
  requireInstallationIdentity:
    process.env.NODE_ENV === "production" && Boolean(process.env.AGENT_BRIDGE_INSTALLATION_ID?.trim()),
  databaseRole: "interactive",
  // Each ACP client spawns this process, and the full foreign-key scan grows
  // with history (≈13 s on a 1.2 GB database). Rollout and the long-lived
  // service startup own that verification; this connection still enforces
  // foreign keys on every write.
  verifyForeignKeyIntegrity: false,
});

// Reconcile only when process ownership and provider containment are proven.
await recoverOutwardLanes(db);

let promptExecutor: BridgeOutwardAcpPromptExecutor | null = null;
try {
  const sessionRepo = new OutwardAcpSessionRepository(db.raw);
  const sessions: OutwardAcpSessionStore = {
    create: (session) => sessionRepo.create(session),
    get: (sessionId) => sessionRepo.get(sessionId),
    list: (cwd, options) => sessionRepo.list(cwd, options),
    update: (sessionId, change) => sessionRepo.update(sessionId, change),
    historyPage: (conversationId, beforeId) => db.getConvHistoryPage(
      conversationId, 50, beforeId, OUTWARD_ACP_SURFACE,
    ),
    history: (conversationId) => db.getRecentConvTurns(
      conversationId,
      OUTWARD_ACP_HISTORY_LIMIT,
      undefined,
      OUTWARD_ACP_SURFACE,
    ).map((turn) => ({ role: turn.role as "user" | "assistant", text: turn.text })),
    userTurnOffset: (conversationId) => {
      const recent = db.getRecentConvTurns(conversationId, OUTWARD_ACP_HISTORY_LIMIT, undefined, OUTWARD_ACP_SURFACE);
      const total = db.getConvHistoryPage(conversationId, 1, undefined, OUTWARD_ACP_SURFACE).turnCount;
      return total - recent.filter((turn) => turn.role === "user").length;
    },
    isCompletedRun: (conversationId, runId) => {
      const run = db.getRun(runId);
      return run?.surface_identity === OUTWARD_ACP_SURFACE && run?.chat_id === conversationId && run?.status === "done";
    },
  };
  // Establish the same bounded API-key evidence interactive routing uses, so
  // canonical provider availability is accurate for key-authenticated hosts.
  try {
    await prepareInteractiveCliAuth(process.env);
  } catch (error) {
    console.error("[outward-acp] provider API-key verification failed", error);
  }
  // Resolve ordinary background wakes through the persisted Workstream owner.
  // Without this lookup a transient ACP client cannot negotiate the already
  // supervised continuation capability even when the worker is installed.
  promptExecutor = createProductionOutwardAcpPromptExecutor(db, dbPath, process.env,
    (sessionId) => sessionRepo.get(sessionId));
  const stream = acp.ndJsonStream(
    Writable.toWeb(process.stdout),
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  );
  const commands = new AcpCommands({
    db,
    config: outwardCommandConfig(dbPath),
    control: promptExecutor,
    codexUsage: getCodexUsageText,
    sensors: new SensorRegistry({ db, dbPath }),
    prepareConfig: (session, provider, command) => prepareInteractiveAcpConfigControl({
      kind: provider, commandText: `/${command}`, surfaceIdentity: OUTWARD_ACP_SURFACE,
      chatKey: session.conversationId, db, executionMode: resolveExecutionMode(provider, process.env), cwd: session.executionCwd ?? session.cwd,
    }),
  });
  const connection = createOutwardAcpAgent({ sessions, promptExecutor, workstreams: promptExecutor, commands, workspaceRoot }).connect(stream);
  await connection.closed;
} finally {
  try {
    await promptExecutor?.shutdown();
  } finally {
    db.close();
  }
}
