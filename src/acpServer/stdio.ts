#!/usr/bin/env node

import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import { getBridgeProjectDir } from "../bridge.js";
import { openProductionDb } from "../db.js";
import { OutwardAcpSessionRepository } from "../repositories/outwardAcpSessionRepository.js";
import { createOutwardAcpAgent } from "./app.js";

const dbPath = process.env.DB_PATH || `${getBridgeProjectDir()}/.data/bridge.sqlite`;
const db = openProductionDb(dbPath, {
  serviceId: "acp:outward",
  installationId: process.env.AGENT_BRIDGE_INSTALLATION_ID,
  requireInstallationIdentity:
    process.env.NODE_ENV === "production" && Boolean(process.env.AGENT_BRIDGE_INSTALLATION_ID?.trim()),
  databaseRole: "interactive",
});
const sessions = new OutwardAcpSessionRepository(db.raw);
const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
);
const connection = createOutwardAcpAgent({ sessions }).connect(stream);

try {
  await connection.closed;
} finally {
  db.close();
}
