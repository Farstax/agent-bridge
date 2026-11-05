#!/usr/bin/env node

import * as acp from "@agentclientprotocol/sdk/unstable";
import { Readable, Writable } from "node:stream";
import { realpathSync } from "node:fs";
import { openProductionDb } from "../db.js";
import { OutwardAcpSessionRepository } from "../repositories/outwardAcpSessionRepository.js";
import { createOutwardAcpAgent, type OutwardAcpSessionStore } from "./app.js";
import { PROVIDER_API_KEY_AUTH, isProviderApiKeyConfigured } from "../providers/apiKeyAuth.js";
import { isManagedProviderId } from "../providers/types.js";
import { prepareInteractiveCliAuth } from "../interactiveCliAuth.js";
import { getCodexUsageText } from "../codexUsage.js";
import { outwardServiceId, recoverOutwardLanes } from "./recovery.js";
import { AcpCommands } from "./commands.js";
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

const startupTimingEnabled = process.env.BRIDGE_ACP_STARTUP_TIMING === "1";
const startupBodyStarted = performance.now();
if (startupTimingEnabled) console.error(JSON.stringify({ event: "acp_startup_timing", phase: "process_uptime_at_body", durationMs: Math.round(process.uptime() * 1000), includesNodeStartup: true }));
let startupPhaseStarted = startupBodyStarted;
function startupPhase(phase: string): void {
  if (!startupTimingEnabled) return;
  const now = performance.now();
  console.error(JSON.stringify({ event: "acp_startup_timing", phase, durationMs: Math.round((now - startupPhaseStarted) * 1000) / 1000 }));
  startupPhaseStarted = now;
}

const bridgeProjectDir = process.env.BRIDGE_PROJECT_DIR || process.cwd();
const workspaceRoot = realpathSync(process.env.BRIDGE_ACP_WORKSPACE_ROOT || bridgeProjectDir);
startupPhase("workspace_root");
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

startupPhase("database_open");

// Reconcile only when process ownership and provider containment are proven.
await recoverOutwardLanes(db);
startupPhase("outward_recovery");

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
  startupPhase("session_setup");
  // Establish the same bounded API-key evidence interactive routing uses, so
  // canonical provider availability is accurate for key-authenticated hosts.
  if (startupTimingEnabled) console.error(JSON.stringify({ event: "acp_startup_timing", phase: "auth_configured", configured: Object.keys(PROVIDER_API_KEY_AUTH).some((provider) => isManagedProviderId(provider) && isProviderApiKeyConfigured(provider, process.env)) }));
  try {
    await prepareInteractiveCliAuth(process.env);
  } catch (error) {
    console.error("[outward-acp] provider API-key verification failed", error);
  }
  startupPhase("auth_preparation");
  promptExecutor = createProductionOutwardAcpPromptExecutor(db, dbPath);
  startupPhase("executor_construction");
  const stream = acp.ndJsonStream(
    Writable.toWeb(process.stdout),
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  );
  const commands = new AcpCommands({
    db,
    config: outwardCommandConfig(dbPath),
    control: promptExecutor,
    codexUsage: getCodexUsageText,
    prepareConfig: (session, provider, command) => prepareInteractiveAcpConfigControl({
      kind: provider, commandText: `/${command}`, surfaceIdentity: OUTWARD_ACP_SURFACE,
      chatKey: session.conversationId, db, executionMode: resolveExecutionMode(provider, process.env), cwd: session.cwd,
    }),
  });
  const connection = createOutwardAcpAgent({ sessions, promptExecutor, workstreams: promptExecutor, commands, workspaceRoot }).connect(stream);
  startupPhase("connection_setup");
  if (startupTimingEnabled) console.error(JSON.stringify({ event: "acp_startup_timing", phase: "body_total", durationMs: Math.round((performance.now() - startupBodyStarted) * 1000) / 1000, moduleImportsIncluded: false }));
  await connection.closed;
} finally {
  try {
    await promptExecutor?.shutdown();
  } finally {
    db.close();
  }
}
