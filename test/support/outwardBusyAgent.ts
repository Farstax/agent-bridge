// Real stdio outward ACP agent with a controllable fake provider, used to run
// several independent processes against one Bridge database (#1130).
//   argv: <dbPath> <workspaceRoot> <controlDir>
// A prompt "hold:<name>" blocks until <controlDir>/release-<name> exists or the
// lane is aborted; every started execution is appended to <controlDir>/executions.log.
import { Readable, Writable } from "node:stream";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { openDb } from "../../src/db.js";
import { OutwardAcpSessionRepository } from "../../src/repositories/outwardAcpSessionRepository.js";
import { createOutwardAcpAgent } from "../../src/acpServer/app.js";
import { AcpCommands } from "../../src/acpServer/commands.js";
import { BridgeOutwardAcpPromptExecutor, OUTWARD_ACP_SURFACE, outwardCommandConfig } from "../../src/acpServer/execution.js";
import { outwardServiceId, recoverOutwardLanes } from "../../src/acpServer/recovery.js";
import { executionLaneCoordinator } from "../../src/executionLaneCoordinator.js";
import { type as eventType } from "../../src/events/types.js";
import { BridgeEngine, type PendingMessage, type QueuedMessageOutcome } from "../../src/engine.js";
import { SAFE_SURFACE_CAPABILITIES, type MessagingPlatform } from "../../src/platform.js";

console.log = (...args: unknown[]) => console.error(...args);
const [dbPath, workspaceRoot, controlDir] = process.argv.slice(2);
const db = openDb(dbPath, { serviceId: outwardServiceId(), databaseRole: "interactive" });
await recoverOutwardLanes(db);
const sessions = new OutwardAcpSessionRepository(db.raw);

let executor!: BridgeOutwardAcpPromptExecutor;
const noDelivery: MessagingPlatform = {
  capabilities: SAFE_SURFACE_CAPABILITIES,
  async sendMessage() { return {}; }, async editMessageText() { return {}; }, async sendChatAction() { return {}; },
  async answerCallbackQuery() { return {}; }, async setMyCommands() { return {}; }, async sendDocument() {}, async sendPhoto() {},
};
const queueCore = new BridgeEngine({
  kind: "codex", surfaceIdentity: OUTWARD_ACP_SURFACE, botConfig: { command: "", modelPreference: [] },
  allowedUserIds: new Set(), executionMode: "safe", pollIntervalMs: 1000,
  hooks: { onQueuedMessage: (message: PendingMessage): Promise<QueuedMessageOutcome> => executor.executeQueuedMessage(sessions.get(message.chatId as string)!, message) },
}, db, noDelivery);

executor = new BridgeOutwardAcpPromptExecutor({
  db,
  providerChain: ["codex"] as const,
  lookupSession: (id) => sessions.get(id),
  discardPendingMessages: (session, before, after) => queueCore.discardPendingMessages(session.conversationId, before, after),
  createEngine: () => ({
    executeSurfaceNeutralTurn: async (input) => {
      const lane = JSON.stringify([OUTWARD_ACP_SURFACE, input.chatKey]);
      const attachments = input.attachments?.map((path) => readFileSync(path, "utf8")) ?? [];
      appendFileSync(join(controlDir, "executions.log"), `${JSON.stringify({ prompt: input.prompt, attachments, pid: process.pid, runId: input.runId })}\n`);
      input.collect(eventType.runStarted({
        runId: input.runId, bot: "codex", chatId: String(input.chatId), chatKey: input.chatKey,
        command: "fake", cwd: workspaceRoot, model: null,
      }));
      const name = input.prompt.startsWith("hold:") ? input.prompt.slice(5).split(/\s/)[0] : null;
      const coordinator = executionLaneCoordinator(db, OUTWARD_ACP_SURFACE);
      while (name && !existsSync(join(controlDir, `release-${name}`))) {
        if (coordinator.isAborted(lane)) return { text: "", sessionId: "fake", stopReason: "cancelled" };
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      input.collect(eventType.runCompleted({
        runId: input.runId, bot: "codex", chatId: String(input.chatId), chatKey: input.chatKey,
        text: `done:${input.prompt}`, sessionId: "fake",
      }));
      return { text: `done:${input.prompt}`, sessionId: "fake", stopReason: "end_turn" };
    },
    recoverPendingQueue: (chatKey) => queueCore.recoverPendingQueue(chatKey),
  }),
});

const commands = new AcpCommands({ db, config: outwardCommandConfig(dbPath, { INTERACTIVE_CLI_CHAIN: "codex" } as NodeJS.ProcessEnv), control: executor });
const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>);
const connection = createOutwardAcpAgent({
  sessions: {
    create: (s) => sessions.create(s), get: (id) => sessions.get(id), list: (cwd, o) => sessions.list(cwd, o),
    update: (id, c) => sessions.update(id, c),
    history: (conversationId) => db.getRecentConvTurns(conversationId, 50, undefined, OUTWARD_ACP_SURFACE)
      .map((t) => ({ role: t.role as "user" | "assistant", text: t.text })),
  },
  promptExecutor: executor, workstreams: executor, commands, workspaceRoot,
}).connect(stream);
await connection.closed;
await executor.shutdown();
db.close();
