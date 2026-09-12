#!/usr/bin/env node

import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import { openProductionDb } from "../db.js";
import { OutwardAcpSessionRepository } from "../repositories/outwardAcpSessionRepository.js";
import { createOutwardAcpAgent } from "./app.js";
import {
  type BridgeOutwardAcpPromptExecutor,
  createProductionOutwardAcpPromptExecutor,
} from "./execution.js";

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
  const sessions = new OutwardAcpSessionRepository(db.raw);
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
