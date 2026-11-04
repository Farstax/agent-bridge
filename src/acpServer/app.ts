import * as acp from "@agentclientprotocol/sdk/unstable";
import { AgentApp } from "@agentclientprotocol/sdk/unstable";
import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { rm, writeFile } from "node:fs/promises";
import { createWhisperCppTranscriber, prepareVoiceTurn, type VoiceTranscriber } from "../voiceIngress.js";
import type { InteractiveTurnInput } from "../interactiveIngress.js";
import type {
  NewOutwardAcpSession,
  OutwardAcpSessionRecord,
} from "../repositories/outwardAcpSessionRepository.js";
import type { OutwardAcpPromptExecutor, OutwardWorkstreamControl } from "./execution.js";
import { type AcpCommands } from "./commands.js";
import { stageOutwardAcpAttachments } from "./attachments.js";
import { listDeskArtifacts, readDeskArtifact } from "./artifacts.js";
import {
  bridgeAgentCapabilities,
  BRIDGE_ACP_AGENT_INFO,
  bridgeAgentProtocolVersion,
} from "./capabilities.js";

export interface OutwardAcpHistoryTurn {
  readonly role: "user" | "assistant";
  readonly text: string;
}

export interface OutwardAcpSessionStore {
  create(session: NewOutwardAcpSession): unknown;
  get?(sessionId: string): OutwardAcpSessionRecord | null;
  /** Durable per-conversation transcript for `session/load` replay, oldest first. */
  history?(conversationId: string): ReadonlyArray<OutwardAcpHistoryTurn>;
  /** Number of user turns excluded from bounded replay. */
  userTurnOffset?(conversationId: string): number;
  /** Durable Run authority for generated files. */
  isCompletedRun?(conversationId: string, runId: string): boolean;
  historyPage?(conversationId: string, beforeId?: number): {
    turns: ReadonlyArray<{ id: number; role: "user" | "assistant"; text: string; createdAt: string; ordinal: number }>;
    nextCursor: number | null;
    turnCount: number;
  };
  list?(cwd: string, options: { includeArchived?: boolean }): OutwardAcpSessionRecord[];
  update?(sessionId: string, change: { title?: string; archived?: boolean }): OutwardAcpSessionRecord | null;
}

export interface OutwardAcpAgentOptions {
  sessions?: OutwardAcpSessionStore;
  promptExecutor?: OutwardAcpPromptExecutor;
  workstreams?: OutwardWorkstreamControl;
  commands?: AcpCommands;
  /** Trusted process-local root; client-supplied cwd values are confined beneath it. */
  workspaceRoot?: string;
  /** Test override; production reuses the pinned local Whisper runtime. */
  voiceTranscriber?: VoiceTranscriber;
}

/**
 * Bridge-owned Workstream controls (#1101). ACP v1 has no standard method for
 * list/rename/archive/status/provider selection, so these use the ACP
 * extension-method namespace (leading underscore) and are advertised under
 * `agentCapabilities._meta`. Standard ACP clients never see or need them.
 */
export const WORKSTREAM_METHODS = {
  list: "_agent-bridge/workstreams/list",
  historyPage: "_agent-bridge/workstreams/history_page",
  update: "_agent-bridge/workstreams/update",
  status: "_agent-bridge/workstreams/status",
  selectProvider: "_agent-bridge/workstreams/select_provider",
  cancelDeferred: "_agent-bridge/workstreams/cancel_deferred",
  commands: "_agent-bridge/commands/list",
  runCommand: "_agent-bridge/commands/run",
  transcribeVoice: "_agent-bridge/voice/transcribe",
  listArtifacts: "_agent-bridge/artifacts/list",
  readArtifact: "_agent-bridge/artifacts/read",
} as const;

const WORKSTREAM_TITLE_MAX = 200;

function objectParams(params: unknown): Record<string, unknown> {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw acp.RequestError.invalidParams({ field: "params" }, "params must be an object");
  }
  return params as Record<string, unknown>;
}

function stringParam(params: Record<string, unknown>, field: string, maxLength = 512): string {
  const value = params[field];
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw acp.RequestError.invalidParams({ field }, `${field} must be a non-empty string`);
  }
  return value;
}

function optionalBoolean(params: Record<string, unknown>, field: string): boolean | undefined {
  const value = params[field];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw acp.RequestError.invalidParams({ field }, `${field} must be a boolean`);
  return value;
}

function titleParam(params: Record<string, unknown>): string | undefined {
  if (params.title === undefined) return undefined;
  const title = typeof params.title === "string" ? params.title.trim() : "";
  // Control characters are rejected rather than stripped so stored titles
  // always equal what the owner submitted.
  if (!title || title.length > WORKSTREAM_TITLE_MAX || /[\u0000-\u001f\u007f]/.test(title)) {
    throw acp.RequestError.invalidParams({ field: "title" }, `title must be 1-${WORKSTREAM_TITLE_MAX} printable characters`);
  }
  return title;
}

function optionalString(params: Record<string, unknown>, field: string, maxLength: number): string | undefined {
  if (params[field] === undefined) return undefined;
  return stringParam(params, field, maxLength);
}

function workstreamView(session: OutwardAcpSessionRecord) {
  return {
    sessionId: session.sessionId,
    conversationId: session.conversationId,
    cwd: session.cwd,
    title: session.title ?? null,
    archived: Boolean(session.archivedAt),
    archivedAt: session.archivedAt ?? null,
    createdAt: session.createdAt,
  };
}

function assertConservativeSessionParams(params: { cwd: string; additionalDirectories?: string[]; mcpServers: unknown[] }): void {
  if (!isAbsolute(params.cwd)) {
    throw acp.RequestError.invalidParams({ field: "cwd" }, "session cwd must be an absolute path");
  }
  if ((params.additionalDirectories?.length ?? 0) > 0) {
    throw acp.RequestError.invalidParams(
      { field: "additionalDirectories" },
      "outward additional directories are not supported",
    );
  }
  if (params.mcpServers.length > 0) {
    throw acp.RequestError.invalidParams({ field: "mcpServers" }, "outward MCP servers are not supported");
  }
}

function authorizeWorkspacePath(cwd: string, workspaceRoot: string): string {
  if (!isAbsolute(cwd)) {
    throw acp.RequestError.invalidParams({ field: "cwd" }, "cwd must be an absolute path");
  }
  let canonical: string;
  try { canonical = realpathSync(cwd); } catch {
    throw acp.RequestError.invalidParams({ field: "cwd" }, "cwd must exist inside the authorized workspace");
  }
  const relativePath = relative(workspaceRoot, canonical);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw acp.RequestError.invalidParams({ field: "cwd" }, "cwd is outside the authorized workspace");
  }
  if (!statSync(canonical).isDirectory()) {
    throw acp.RequestError.invalidParams({ field: "cwd" }, "cwd must be a directory");
  }
  return canonical;
}

function replayUpdate(sessionId: string, turn: OutwardAcpHistoryTurn): acp.SessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate: turn.role === "user" ? "user_message_chunk" : "agent_message_chunk",
      content: { type: "text", text: turn.text },
    },
  };
}

/** Client-chosen idempotency token for a queued submission; anything else is ignored. */
function boundedRequestId(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : undefined;
}

function promptText(prompt: readonly acp.ContentBlock[]): string {
  const parts = prompt.flatMap((block) => {
    if (block.type === "text") return [block.text];
    if (block.type === "resource_link") {
      return [`[ACP resource_link] ${block.name} (${block.mimeType ?? "unknown type"}): ${block.uri}`];
    }
    return [];
  });
  const text = parts.join("\n\n");
  return text || (prompt.some((block) => block.type === "image" || block.type === "resource") ? "Please review the attached files." : "");
}

/**
 * Workspace-local outward ACP agent surface. Lifecycle methods are registered
 * only when their durable/runtime owners are supplied; unsupported methods
 * otherwise stay absent and fail closed through ACP method-not-found handling.
 */
export function createOutwardAcpAgent(options: OutwardAcpAgentOptions = {}): AgentApp {
  const workspaceRoot = realpathSync(options.workspaceRoot ?? process.cwd());
  if (!statSync(workspaceRoot).isDirectory()) throw new Error("outward ACP workspace root must be a directory");
  const sessions = options.sessions;
  const supportsLoad = Boolean(sessions?.get && sessions?.history);
  const workstreams = options.workstreams;
  const supportsWorkstreams = Boolean(workstreams && sessions?.get && sessions.list && sessions.update);
  let app = acp.agent({ name: "agent-bridge" }).onRequest(acp.methods.agent.initialize, () => ({
    protocolVersion: bridgeAgentProtocolVersion(),
    agentCapabilities: bridgeAgentCapabilities({
      loadSession: supportsLoad,
      workstreams: supportsWorkstreams,
      commands: supportsWorkstreams && Boolean(options.commands),
      deferredCapacity: supportsWorkstreams && options.promptExecutor?.supportsDeferredCapacity === true,
      busyMessages: supportsWorkstreams && options.promptExecutor?.supportsBusyMessages === true,
      artifacts: supportsWorkstreams && Boolean(sessions.isCompletedRun),
      historyPages: supportsWorkstreams && Boolean(sessions?.historyPage),
    }),
    agentInfo: { ...BRIDGE_ACP_AGENT_INFO },
  }));
  if (!sessions) return app;

  if (supportsWorkstreams) {
    const control = workstreams!;
    const getKnown = (params: Record<string, unknown>): OutwardAcpSessionRecord => {
      const session = sessions.get!(stringParam(params, "sessionId"));
      if (!session) throw acp.RequestError.invalidParams({ field: "sessionId" }, "unknown outward ACP session");
      // A Workstream is addressed within its workspace directory; a client
      // must present the matching cwd, exactly as session/load requires.
      if (session.cwd !== authorizeWorkspacePath(stringParam(params, "cwd", 4096), workspaceRoot)) {
        throw acp.RequestError.invalidParams({ field: "cwd" }, "session cwd does not match the Workstream");
      }
      return session;
    };
    app = app
      .onRequest(WORKSTREAM_METHODS.historyPage, objectParams, (ctx) => {
        if (!sessions.historyPage) throw new acp.RequestError(-32601, "History pages not supported");
        const session = getKnown(ctx.params);
        const beforeId = ctx.params.beforeId;
        if (beforeId !== undefined && (!Number.isSafeInteger(beforeId) || (beforeId as number) < 1)) {
          throw acp.RequestError.invalidParams({ field: "beforeId" }, "invalid history cursor");
        }
        const page = sessions.historyPage(session.conversationId, beforeId as number | undefined);
        const messages: Array<{ id: string; role: "user" | "assistant"; text: string; createdAt: string; state: "complete" }> = [];
        for (const turn of page.turns) {
          const id = `${session.sessionId}:${turn.role}:${turn.ordinal}`;
          const last = messages.at(-1);
          if (turn.role === "assistant" && last?.id === id) last.text += turn.text;
          else messages.push({ id, role: turn.role, text: turn.text, createdAt: turn.createdAt, state: "complete" });
        }
        return { messages, nextCursor: page.nextCursor, hasMore: page.nextCursor !== null, turnCount: page.turnCount };
      })
      .onRequest(WORKSTREAM_METHODS.list, objectParams, (ctx) => {
        const cwd = authorizeWorkspacePath(stringParam(ctx.params, "cwd", 4096), workspaceRoot);
        const includeArchived = optionalBoolean(ctx.params, "includeArchived") ?? false;
        const listed = sessions.list!(cwd, { includeArchived });
        const statuses = control.statusMany?.(listed) ?? listed.map((session) => control.status(session));
        return {
          workstreams: listed.map((session, index) => ({
            ...workstreamView(session),
            status: statuses[index],
          })),
        };
      })
      .onRequest(WORKSTREAM_METHODS.update, objectParams, (ctx) => {
        const session = getKnown(ctx.params);
        const title = titleParam(ctx.params);
        const archived = optionalBoolean(ctx.params, "archived");
        if (title === undefined && archived === undefined) {
          throw acp.RequestError.invalidParams({ field: "params" }, "nothing to update");
        }
        if (control.status(session).state === "waiting") {
          throw new acp.RequestError(-32002, "deferred Workstream cannot be modified until completion or cancellation");
        }
        const updated = sessions.update!(session.sessionId, { title, archived });
        return { workstream: workstreamView(updated!) };
      })
      .onRequest(WORKSTREAM_METHODS.status, objectParams, (ctx) => {
        const session = getKnown(ctx.params);
        return { workstream: workstreamView(session), status: control.status(session) };
      })
      .onRequest(WORKSTREAM_METHODS.selectProvider, objectParams, (ctx) => {
        const session = getKnown(ctx.params);
        const status = control.selectProvider(session, stringParam(ctx.params, "provider", 64));
        return { workstream: workstreamView(session), status };
      })
      .onRequest(WORKSTREAM_METHODS.cancelDeferred, objectParams, async (ctx) => {
        if (!control.cancelDeferred) throw new acp.RequestError(-32002, "deferred Workstream cancellation is unavailable");
        const session = getKnown(ctx.params);
        return { workstream: workstreamView(session), status: await control.cancelDeferred(session) };
      });
    // These requests resolve the Workstream on the guest and never accept
    // filesystem paths supplied by a browser/ACP client.
    app = app
      .onRequest(WORKSTREAM_METHODS.listArtifacts, objectParams, async (ctx) => {
        const session = getKnown(ctx.params);
        const offset = sessions.historyPage ? 0 : (sessions.userTurnOffset?.(session.conversationId) ?? 0);
        const artifacts = await listDeskArtifacts(session.conversationId);
        return { artifacts: artifacts.filter((item) => sessions.isCompletedRun?.(session.conversationId, item.runId))
          .map((item) => ({ ...item, turnIndex: item.turnIndex - offset })) };
      })
      .onRequest(WORKSTREAM_METHODS.readArtifact, objectParams, async (ctx) => {
        const session = getKnown(ctx.params);
        const id = stringParam(ctx.params, "artifactId", 64);
        const result = await readDeskArtifact(session.conversationId, id);
        return result.status === "found" && !sessions.isCompletedRun?.(session.conversationId, result.artifact.runId)
          ? { status: "not_found" as const } : result;
      });
    if (options.commands) {
      const commands = options.commands;
      app = app
        .onRequest(WORKSTREAM_METHODS.commands, objectParams, (ctx) => ({
          commands: commands.catalogue(getKnown(ctx.params)),
        }))
        .onRequest(WORKSTREAM_METHODS.runCommand, objectParams, async (ctx) => {
          const session = getKnown(ctx.params);
          if (control.status(session).state === "waiting") {
            const command = stringParam(ctx.params, "command", 64);
            if (command !== "help" && command !== "status") {
              throw new acp.RequestError(-32002, "deferred Workstream is waiting; cancel it before modifying");
            }
          }
          return commands.run(session, {
            command: stringParam(ctx.params, "command", 64),
            argument: optionalString(ctx.params, "argument", 16_384),
            select: optionalString(ctx.params, "select", 256),
            confirm: optionalBoolean(ctx.params, "confirm"),
          });
        });
    }
  }

  app = app.onRequest(acp.methods.agent.session.new, (ctx) => {
    assertConservativeSessionParams(ctx.params);
    const sessionId = randomUUID();
    const conversationId = `acp:${randomUUID()}`;
    const cwd = authorizeWorkspacePath(ctx.params.cwd, workspaceRoot);
    sessions.create({ sessionId, conversationId, cwd });
    return { sessionId };
  });

  if (supportsLoad) {
    const getSessionForLoad = sessions.get!.bind(sessions);
    const history = sessions.history!.bind(sessions);
    app = app.onRequest(acp.methods.agent.session.load, async (ctx) => {
      assertConservativeSessionParams(ctx.params);
      const session = getSessionForLoad(ctx.params.sessionId);
      if (!session) {
        throw acp.RequestError.invalidParams({ field: "sessionId" }, "unknown outward ACP session");
      }
      if (session.cwd !== authorizeWorkspacePath(ctx.params.cwd, workspaceRoot)) {
        throw acp.RequestError.invalidParams({ field: "cwd" }, "session cwd does not match the loaded session");
      }
      for (const turn of history(session.conversationId)) {
        await ctx.client.notify(acp.methods.client.session.update, replayUpdate(session.sessionId, turn));
      }
      return {};
    });
  }

  // Voice is a pre-prompt operation. It never starts a Run or persists raw
  // microphone audio: Desk submits the returned text through session/prompt.
  if (sessions.get) {
    const getSessionForVoice = sessions.get.bind(sessions);
    app = app.onRequest(WORKSTREAM_METHODS.transcribeVoice, objectParams, async (ctx) => {
      const session = getSessionForVoice(stringParam(ctx.params, "sessionId"));
      if (!session) throw acp.RequestError.invalidParams({ field: "sessionId" }, "unknown outward ACP session");
      const cwd = authorizeWorkspacePath(stringParam(ctx.params, "cwd", 4096), workspaceRoot);
      if (session.cwd !== cwd) throw acp.RequestError.invalidParams({ field: "cwd" }, "session cwd does not match the Workstream");
      const format = stringParam(ctx.params, "mimeType", 128).toLowerCase().split(";")[0]!.trim();
      const extensions: Record<string, string> = {
        "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a",
        "audio/wav": "wav", "audio/mpeg": "mp3",
      };
      const extension = extensions[format];
      if (!extension) throw acp.RequestError.invalidParams({ field: "mimeType" }, "unsupported voice recording format");
      const encoded = ctx.params.audioBase64;
      const maximum = 8 * 1024 * 1024;
      if (typeof encoded !== "string" || !encoded || encoded.length > Math.ceil(maximum / 3) * 4
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
        throw acp.RequestError.invalidParams({ field: "audioBase64" }, "invalid or oversized voice recording");
      }
      const audio = Buffer.from(encoded, "base64");
      if (audio.byteLength === 0 || audio.byteLength > maximum || audio.toString("base64") !== encoded) {
        throw acp.RequestError.invalidParams({ field: "audioBase64" }, "invalid or oversized voice recording");
      }
      const input: InteractiveTurnInput = {
        surfaceIdentity: "desk:outward-acp", chatKey: session.sessionId,
        actorId: "desk", messageId: randomUUID(), text: "",
        delivery: { chatId: session.sessionId, chatType: "private" },
        attachments: [{ kind: "audio", fileId: "desk-voice", fileName: `recording.${extension}`,
          mimeType: format, fileSize: audio.byteLength }],
      };
      const prepared = await prepareVoiceTurn(input, {
        transcriber: options.voiceTranscriber ?? createWhisperCppTranscriber(),
        signal: ctx.signal, workspaceDir: cwd, maxAudioBytes: maximum,
        stager: { async stage({ operationDir }) {
          const path = join(operationDir, `recording.${extension}`);
          await writeFile(path, audio, { mode: 0o600 });
          return path;
        } },
      });
      if (prepared.kind === "ready") return { text: prepared.turn.text };
      if (prepared.kind === "failed" && prepared.retainedAttachmentPath) {
        await rm(dirname(prepared.retainedAttachmentPath), { recursive: true, force: true });
      }
      throw new acp.RequestError(-32002,
        prepared.kind === "cancelled" ? "Voice transcription cancelled"
          : prepared.kind === "unavailable" ? prepared.reason
          : "Voice transcription failed");
    });
  }

  if (!options.promptExecutor || !sessions.get) return app;
  const promptExecutor = options.promptExecutor;
  const getSession = sessions.get.bind(sessions);
  app = app.onRequest(acp.methods.agent.session.prompt, async (ctx) => {
    const session = getSession(ctx.params.sessionId);
    if (!session) {
      throw acp.RequestError.invalidParams(
        { field: "sessionId" },
        "unknown outward ACP session",
      );
    }
    const authorizedCwd = authorizeWorkspacePath(session.cwd, workspaceRoot);
    const prompt = promptText(ctx.params.prompt);
    const requestId = boundedRequestId(ctx.params._meta?.["agent-bridge/request-id"]);
    const busyMessages = supportsWorkstreams && promptExecutor.supportsBusyMessages === true
      && ctx.params._meta?.["agent-bridge/busy-messages"] === 1;
    if (busyMessages && !requestId) {
      throw acp.RequestError.invalidParams({ field: "_meta.agent-bridge/request-id" }, "busy-message opt-in requires a stable request ID");
    }
    try {
      return await stageOutwardAcpAttachments(authorizedCwd, ctx.params.prompt, (attachments, runId) => promptExecutor.execute({
        session,
        prompt: attachments.length
          ? `${prompt}\n\n${attachments.map((path) => `[Attached file: ${basename(path)}]`).join("\n")}`
          : prompt,
        attachments,
        ...(runId ? { runId } : {}),
        signal: ctx.signal,
        deferCapacity: ctx.params._meta?.["agent-bridge/defer-capacity"] === 1,
        busyMessages,
        requestId,
        onUpdate: (update) => ctx.client.notify(acp.methods.client.session.update, {
          sessionId: session.sessionId,
          update,
        }),
      }));
    } catch (error) {
      if (error instanceof acp.RequestError) throw error;
      throw acp.RequestError.invalidParams({ field: "prompt" }, error instanceof Error ? error.message : "invalid attachments");
    }
  });

  return app.onNotification(acp.methods.agent.session.cancel, async (ctx) => {
    const session = getSession(ctx.params.sessionId);
    if (!session) return;
    await promptExecutor.cancelActive(session);
  });
}
