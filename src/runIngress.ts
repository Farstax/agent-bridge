/**
 * Authenticated, provider-neutral ingress for one ordinary surface-neutral Run.
 * This module owns request validation and durable deduplication only. Provider
 * execution, locking, continuation, fencing, and terminal Run state remain in
 * BridgeEngine and EventStore.
 */
import { randomUUID } from "node:crypto";
import { chmodSync, unlinkSync } from "node:fs";
import { createServer, type Server } from "node:net";
import type { BridgeDb, ExecutionLaneHandle } from "./db.js";
import type { BotKind } from "./types.js";
import type { BridgeEngine, SurfaceNeutralTurnInput } from "./engine.js";
import { EventStore } from "./events/store.js";
import type { BridgeEvent } from "./events/types.js";

// The existing receipt schema deliberately allows only the two durable
// ingress sources. This generic capability uses the existing autonomous
// source without adding a new persistence concept.
export const RUN_INGRESS_SOURCE = "autonomous" as const;
export const RUN_INGRESS_EVENT_KIND = "ordinary_run" as const;
export const RUN_INGRESS_SURFACE = "run-ingress" as const;
const MAX_REQUEST_BYTES = 16_384;
const MAX_PROMPT_CHARS = 12_000;
const MAX_RESULT_CHARS = 8_000;
const MAX_ERROR_CHARS = 256;

export interface RunIngressRequest {
  requestId: string;
  idempotencyKey: string;
  scopeKey: string;
  prompt: string;
  token: string;
  occurredAt?: string;
}

export interface AcceptedRunIngressRequest {
  receiptId: number;
  runId: string;
  created: boolean;
}

export interface RunIngressResponse {
  runId: string;
  status: "done" | "failed" | "cancelled";
  result?: string;
  errorClass?: "authentication" | "invalid_request" | "execution" | "ambiguous";
}

export type RunIngressEngine = Pick<BridgeEngine, "executeSurfaceNeutralTurn">;

export class RunIngressAuthenticationError extends Error {}
export class RunIngressRequestError extends Error {}

function bounded(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function requireBoundedString(name: string, value: unknown, max: number, pattern?: RegExp): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || (pattern && !pattern.test(value))) {
    throw new RunIngressRequestError(`invalid ${name}`);
  }
  return value;
}

function validateRequest(input: RunIngressRequest): void {
  requireBoundedString("requestId", input.requestId, 128, /^[A-Za-z0-9._:-]+$/);
  requireBoundedString("idempotencyKey", input.idempotencyKey, 256, /^[A-Za-z0-9._:/-]+$/);
  requireBoundedString("scopeKey", input.scopeKey, 128, /^[A-Za-z0-9._:-]+$/);
  requireBoundedString("prompt", input.prompt, MAX_PROMPT_CHARS);
  if (input.occurredAt !== undefined) requireBoundedString("occurredAt", input.occurredAt, 64);
  if (Buffer.byteLength(JSON.stringify({ ...input, token: "[redacted]" }), "utf8") > MAX_REQUEST_BYTES) {
    throw new RunIngressRequestError("request exceeds size limit");
  }
}

function runChatKey(scopeKey: string): string {
  return `${RUN_INGRESS_SURFACE}:${scopeKey}`;
}

export function acceptRunIngressRequest(
  db: BridgeDb,
  input: RunIngressRequest,
  options: { expectedToken?: string; bot?: BotKind; runId?: () => string; now?: () => string },
): AcceptedRunIngressRequest {
  if (!options.expectedToken || input.token !== options.expectedToken) {
    throw new RunIngressAuthenticationError("run ingress authentication failed");
  }
  validateRequest(input);
  const existing = db.getEventReceiptByIdempotencyKey(input.idempotencyKey);
  if (existing) {
    if (!existing.run_id) throw new Error("run ingress receipt has no linked Run");
    return { receiptId: existing.id, runId: existing.run_id, created: false };
  }
  const receipt = db.createEventReceipt({
    event_id: input.requestId,
    source: RUN_INGRESS_SOURCE,
    event_kind: RUN_INGRESS_EVENT_KIND,
    idempotency_key: input.idempotencyKey,
    occurred_at: input.occurredAt ?? new Date().toISOString(),
    received_at: options.now?.() ?? new Date().toISOString(),
    payload_json: JSON.stringify({ scopeKey: input.scopeKey, prompt: input.prompt }),
    authority_scope: "ordinary-run",
  });
  return db.runInTransaction(() => {
    const current = db.getEventReceipt(receipt.id);
    if (!current) throw new Error("run ingress receipt disappeared");
    if (current.run_id) return { receiptId: current.id, runId: current.run_id, created: false };
    const runId = options.runId?.() ?? randomUUID();
    db.insertRun(runId, runChatKey(input.scopeKey), options.bot ?? "claude");
    db.linkEventReceiptRun(current.id, runId);
    return { receiptId: current.id, runId, created: true };
  });
}

function terminalResponse(db: BridgeDb, runId: string): RunIngressResponse | null {
  const run = db.getRun(runId);
  if (!run || run.status === "running") return null;
  if (run.status === "done") {
    const completed = db.getEventsForRun(runId).find((event) => event.type === "run.completed");
    const payload = completed ? JSON.parse(String(completed.payload_json)) as { text?: unknown } : {};
    return { runId, status: "done", result: typeof payload.text === "string" ? bounded(payload.text, MAX_RESULT_CHARS) : "" };
  }
  return {
    runId,
    status: run.status === "cancelled" ? "cancelled" : "failed",
    errorClass: run.status === "cancelled" ? "ambiguous" : "execution",
  };
}

export async function executeRunIngressRequest(
  db: BridgeDb,
  receiptId: number,
  engine: RunIngressEngine,
  options: { bot?: BotKind } = {},
): Promise<RunIngressResponse> {
  const receipt = db.getEventReceipt(receiptId);
  if (!receipt?.run_id) throw new Error("run ingress receipt has no linked Run");
  const runId = receipt.run_id;
  const existing = terminalResponse(db, runId);
  if (existing) return existing;
  const payload = JSON.parse(receipt.payload_json) as { scopeKey: string; prompt: string };
  const chatKey = runChatKey(payload.scopeKey);
  const lane: ExecutionLaneHandle | null = db.acquireLock(RUN_INGRESS_SURFACE, chatKey);
  if (!lane) return { runId, status: "failed", errorClass: "ambiguous" };
  const eventStore = new EventStore(db, runId);
  const collect = (event: BridgeEvent) => event.type === "run.completed" ? eventStore.queueCompleted(event) : eventStore.collect(event);
  try {
    const current = terminalResponse(db, runId);
    if (current) return current;
    const eventContext: NonNullable<SurfaceNeutralTurnInput["eventContext"]> = {
      runId,
      bot: options.bot ?? "claude",
      chatId: chatKey,
      threadId: undefined,
      serviceId: lane.serviceId,
      acquisitionId: lane.acquisitionId,
    };
    const result = await engine.executeSurfaceNeutralTurn({
      prompt: payload.prompt,
      sessionId: null,
      chatId: 0,
      chatKey,
      laneHandle: lane,
      runId,
      eventContext,
      collect,
      finalize: () => eventStore.finalize(),
      onProviderExecutionStarted: () => undefined,
    });
    eventStore.finalize();
    db.recordEventReceiptResult(receiptId, { status: "completed", result_reference: runId, error_class: null });
    return terminalResponse(db, runId) ?? { runId, status: "done", result: bounded(result.text, MAX_RESULT_CHARS) };
  } catch (error) {
    eventStore.finalize();
    db.updateRunFailed(runId, "run ingress execution failed");
    db.recordEventReceiptResult(receiptId, { status: "failed", result_reference: runId, error_class: "execution" });
    return { runId, status: "failed", errorClass: "execution" };
  } finally {
    db.unlock(lane);
  }
}

interface WireResponse { ok: boolean; response?: RunIngressResponse; error?: string }

export class RunIngressServer {
  private server: Server | null = null;
  constructor(private readonly options: {
    socketPath: string;
    expectedToken: string;
    accept: (request: RunIngressRequest) => AcceptedRunIngressRequest;
    execute: (receiptId: number) => Promise<RunIngressResponse>;
  }) {}

  async start(): Promise<void> {
    if (this.server) return;
    this.server = createServer({ allowHalfOpen: true }, (socket) => {
      let raw = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        raw += chunk;
        if (Buffer.byteLength(raw, "utf8") > MAX_REQUEST_BYTES) socket.destroy(new Error("request too large"));
      });
      socket.on("end", () => {
        void this.handle(raw).then((response) => socket.end(`${JSON.stringify(response)}\n`));
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.options.socketPath, () => {
        this.server!.off("error", reject);
        chmodSync(this.options.socketPath, 0o600);
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    try { unlinkSync(this.options.socketPath); } catch { /* already removed */ }
  }

  private async handle(raw: string): Promise<WireResponse> {
    try {
      const request = JSON.parse(raw) as RunIngressRequest;
      if (request.token !== this.options.expectedToken) throw new RunIngressAuthenticationError("run ingress authentication failed");
      const accepted = this.options.accept(request);
      return { ok: true, response: await this.options.execute(accepted.receiptId) };
    } catch (error) {
      const message = error instanceof RunIngressRequestError || error instanceof RunIngressAuthenticationError
        ? error.message : "run ingress request failed";
      return { ok: false, error: bounded(message, MAX_ERROR_CHARS) };
    }
  }
}
