/**
 * Hermetic Slack stand-in for process-level acceptance tests: the Web API
 * methods the Slack companion uses plus a minimal RFC 6455 Socket Mode server.
 * It speaks the real wire shapes (hello with connection_info.app_id, events_api
 * envelopes, envelope acknowledgements) so the real SDK clients run unmodified.
 */
import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import type { AddressInfo } from "node:net";

export interface FakeSlackOptions {
  appId?: string;
  teamId?: string;
  botUserId?: string;
  botId?: string;
  /** app_id the socket hello announces (defaults to `appId`). */
  helloAppId?: string | null;
  users?: Record<string, { is_bot?: boolean; deleted?: boolean; team_id?: string }>;
}

interface Posted { channel: string; thread_ts?: string; text: string; at: number }

class Peer {
  private buffer = Buffer.alloc(0);
  closed = false;
  constructor(readonly socket: Duplex, private readonly onText: (text: string) => void, private readonly onClose: () => void) {
    socket.on("data", (chunk: Buffer) => { this.buffer = Buffer.concat([this.buffer, chunk]); this.drain(); });
    socket.on("close", () => { this.closed = true; onClose(); });
    socket.on("error", () => { this.closed = true; });
  }
  private drain(): void {
    for (;;) {
      if (this.buffer.length < 2) return;
      const first = this.buffer[0];
      const second = this.buffer[1];
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) { if (this.buffer.length < 4) return; length = this.buffer.readUInt16BE(2); offset = 4; }
      else if (length === 127) { if (this.buffer.length < 10) return; length = Number(this.buffer.readBigUInt64BE(2)); offset = 10; }
      const maskLength = masked ? 4 : 0;
      if (this.buffer.length < offset + maskLength + length) return;
      const mask = masked ? this.buffer.subarray(offset, offset + 4) : null;
      const payload = Buffer.from(this.buffer.subarray(offset + maskLength, offset + maskLength + length));
      if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
      this.buffer = this.buffer.subarray(offset + maskLength + length);
      const opcode = first & 0x0f;
      if (opcode === 1) this.onText(payload.toString("utf8"));
      else if (opcode === 9) this.frame(0x0a, payload);
      else if (opcode === 8) { this.frame(0x08, payload); this.socket.end(); }
    }
  }
  private frame(opcode: number, payload: Buffer): void {
    if (this.closed) return;
    const header = payload.length < 126
      ? Buffer.from([0x80 | opcode, payload.length])
      : payload.length < 65536
        ? Buffer.from([0x80 | opcode, 126, payload.length >> 8, payload.length & 0xff])
        : (() => { const h = Buffer.alloc(10); h[0] = 0x80 | opcode; h[1] = 127; h.writeBigUInt64BE(BigInt(payload.length), 2); return h; })();
    this.socket.write(Buffer.concat([header, payload]));
  }
  sendText(text: string): void { this.frame(0x01, Buffer.from(text, "utf8")); }
  ping(): void { this.frame(0x09, Buffer.alloc(0)); }
  close(): void { this.frame(0x08, Buffer.alloc(0)); this.socket.end(); }
}

export class FakeSlackServer {
  readonly posted: Posted[] = [];
  readonly acks: string[] = [];
  readonly apiCalls: string[] = [];
  readonly tokensSeen = new Set<string>();
  private readonly server: Server;
  private readonly peers = new Set<Peer>();
  private readonly waiters: Array<() => void> = [];
  private counter = 0;
  connectionCount = 0;
  failPostWith: ((text: string) => { status: number; body?: unknown } | null) | null = null;

  constructor(private readonly options: FakeSlackOptions = {}) {
    this.server = createServer((req, res) => void this.handleHttp(req, res));
    this.server.on("upgrade", (req, socket) => this.handleUpgrade(req, socket as Duplex));
  }

  get appId(): string { return this.options.appId ?? "A0APP"; }
  get teamId(): string { return this.options.teamId ?? "T0TEAM"; }
  get botUserId(): string { return this.options.botUserId ?? "U0BOT"; }

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/api/`;
  }

  async stop(): Promise<void> {
    for (const peer of this.peers) peer.socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private notify(): void { for (const w of this.waiters.splice(0)) w(); }

  async waitFor(condition: () => boolean, timeoutMs = 15_000, label = "condition"): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await new Promise<void>((resolve) => { this.waiters.push(resolve); setTimeout(resolve, 50); });
    }
  }

  private async readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    if ((req.headers["content-type"] ?? "").includes("application/json")) return raw ? JSON.parse(raw) : {};
    return Object.fromEntries(new URLSearchParams(raw));
  }

  private async handleHttp(req: IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
    const method = (req.url ?? "").split("?")[0].replace(/^\/api\//, "");
    const auth = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (auth) this.tokensSeen.add(auth);
    const body = await this.readBody(req);
    this.apiCalls.push(method);
    const json = (status: number, value: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    switch (method) {
      case "auth.test":
        return json(200, { ok: true, team_id: this.teamId, user_id: this.botUserId, bot_id: this.options.botId ?? "B0BOT" });
      case "bots.info":
        return json(200, { ok: true, bot: { id: body.bot, app_id: this.appId } });
      case "users.info": {
        const user = this.options.users?.[String(body.user)];
        if (user === undefined && this.options.users) return json(200, { ok: false, error: "user_not_found" });
        return json(200, { ok: true, user: { id: body.user, team_id: this.teamId, ...(user ?? {}) } });
      }
      case "apps.connections.open": {
        const host = req.headers.host;
        return json(200, { ok: true, url: `ws://${host}/socket?ticket=${randomUUID()}` });
      }
      case "chat.postMessage": {
        const text = String(body.text ?? "");
        const injected = this.failPostWith?.(text);
        if (injected) return json(injected.status, injected.body ?? { ok: false, error: "fatal_error" });
        this.counter += 1;
        const posted: Posted = { channel: String(body.channel), text, at: Date.now(), ...(body.thread_ts ? { thread_ts: String(body.thread_ts) } : {}) };
        this.posted.push(posted);
        this.notify();
        return json(200, { ok: true, channel: posted.channel, ts: `1800000000.${String(this.counter).padStart(6, "0")}` });
      }
      default:
        return json(200, { ok: false, error: "unknown_method" });
    }
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex): void {
    const key = String(req.headers["sec-websocket-key"] ?? "");
    const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const peer = new Peer(socket, (text) => {
      try {
        const message = JSON.parse(text) as { envelope_id?: string };
        if (message.envelope_id) { this.acks.push(message.envelope_id); this.notify(); }
      } catch { /* ignore */ }
    }, () => { this.peers.delete(peer); this.notify(); });
    this.peers.add(peer);
    this.connectionCount += 1;
    const helloAppId = this.options.helloAppId === undefined ? this.appId : this.options.helloAppId;
    peer.sendText(JSON.stringify({
      type: "hello",
      num_connections: 1,
      connection_info: helloAppId === null ? {} : { app_id: helloAppId },
      debug_info: { host: "fake", started: new Date().toISOString() },
    }));
    this.notify();
  }

  get connected(): boolean { return [...this.peers].some((p) => !p.closed); }

  /** Push one events_api envelope; resolves with the envelope id. */
  push(event: Record<string, unknown>, overrides: { eventId?: string; teamId?: string; appId?: string } = {}): string {
    const envelopeId = randomUUID();
    const peer = [...this.peers].find((p) => !p.closed);
    if (!peer) throw new Error("no connected socket");
    peer.sendText(JSON.stringify({
      type: "events_api",
      envelope_id: envelopeId,
      accepts_response_payload: false,
      payload: {
        team_id: overrides.teamId ?? this.teamId,
        api_app_id: overrides.appId ?? this.appId,
        event_id: overrides.eventId ?? `Ev${randomUUID().slice(0, 8)}`,
        type: "event_callback",
        event,
      },
    }));
    return envelopeId;
  }

  /** Slack-initiated disconnect; the SDK is expected to reconnect and be re-verified. */
  dropConnections(): void { for (const peer of [...this.peers]) peer.close(); }
}
