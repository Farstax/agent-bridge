#!/usr/bin/env node

import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import { realpathSync } from "node:fs";
import { openProductionDb } from "../db.js";
import { OutwardAcpSessionRepository } from "../repositories/outwardAcpSessionRepository.js";
import { createOutwardAcpAgent, type OutwardAcpSessionStore } from "./app.js";
import { prepareInteractiveCliAuth } from "../interactiveCliAuth.js";
import { getCodexUsageText } from "../codexUsage.js";
import { outwardServiceId, recoverOutwardLanes } from "./recovery.js";
import { DeskCommands } from "./commands.js";
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

const bridgeProjectDir = process.env.BRIDGE_PROJECT_DIR || process.cwd();
const workspaceRoot = realpathSync(process.env.BRIDGE_ACP_WORKSPACE_ROOT || bridgeProjectDir);
const dbPath = process.env.DB_PATH || `${bridgeProjectDir}/.data/bridge.sqlite`;
const db = openProductionDb(dbPath, {
  serviceId: outwardServiceId(),
  installationId: process.env.AGENT_BRIDGE_INSTALLATION_ID,
  requireInstallationIdentity:
    process.env.NODE_ENV === "production" && Boolean(process.env.AGENT_BRIDGE_INSTALLATION_ID?.trim()),
  databaseRole: "interactive",
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
    history: (conversationId) => db.getRecentConvTurns(
      conversationId,
      OUTWARD_ACP_HISTORY_LIMIT,
      undefined,
      OUTWARD_ACP_SURFACE,
    ).map((turn) => ({ role: turn.role as "user" | "assistant", text: turn.text })),
  };
  // Establish the same bounded API-key evidence interactive routing uses, so
  // canonical provider availability is accurate for key-authenticated hosts.
  try {
    await prepareInteractiveCliAuth(process.env);
  } catch (error) {
    console.error("[outward-acp] provider API-key verification failed", error);
  }
  promptExecutor = createProductionOutwardAcpPromptExecutor(db, dbPath);
  const stream = acp.ndJsonStream(
    Writable.toWeb(process.stdout),
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  );
  const commands = new DeskCommands({
    db,
    config: outwardCommandConfig(dbPath),
    control: promptExecutor,
    codexUsage: getCodexUsageText,
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
