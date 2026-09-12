#!/usr/bin/env node

import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import { openProductionDb } from "../db.js";
import { OutwardAcpSessionRepository } from "../repositories/outwardAcpSessionRepository.js";
import { createOutwardAcpAgent, type OutwardAcpSessionStore } from "./app.js";
import {
  OUTWARD_ACP_SURFACE,
  type BridgeOutwardAcpPromptExecutor,
  createProductionOutwardAcpPromptExecutor,
} from "./execution.js";

const OUTWARD_ACP_HISTORY_LIMIT = 200;

// stdout is the ACP wire. Bridge/provider diagnostics must never corrupt NDJSON.
console.log = (...args: unknown[]) => console.error(...args);
console.info = (...args: unknown[]) => console.error(...args);

const bridgeProjectDir = process.env.BRIDGE_PROJECT_DIR || process.cwd();
const dbPath = process.env.DB_PATH || `${bridgeProjectDir}/.data/bridge.sqlite`;
const db = openProductionDb(dbPath, {
  serviceId: "acp:outward",
  installationId: process.env.AGENT_BRIDGE_INSTALLATION_ID,
  requireInstallationIdentity:
    process.env.NODE_ENV === "production" && Boolean(process.env.AGENT_BRIDGE_INSTALLATION_ID?.trim()),
  databaseRole: "interactive",
});

let promptExecutor: BridgeOutwardAcpPromptExecutor | null = null;
try {
  const sessionRepo = new OutwardAcpSessionRepository(db.raw);
  const sessions: OutwardAcpSessionStore = {
    create: (session) => sessionRepo.create(session),
    get: (sessionId) => sessionRepo.get(sessionId),
    history: (conversationId) => db.getRecentConvTurns(
      conversationId,
      OUTWARD_ACP_HISTORY_LIMIT,
      undefined,
      OUTWARD_ACP_SURFACE,
    ).map((turn) => ({ role: turn.role as "user" | "assistant", text: turn.text })),
  };
  promptExecutor = createProductionOutwardAcpPromptExecutor(db, dbPath);
  const stream = acp.ndJsonStream(
    Writable.toWeb(process.stdout),
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  );
  const connection = createOutwardAcpAgent({ sessions, promptExecutor }).connect(stream);
  await connection.closed;
} finally {
  try {
    await promptExecutor?.shutdown();
  } finally {
    db.close();
  }
}
