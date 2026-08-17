import { createServer, type Server } from "node:http";
import { existsSync, lstatSync, unlinkSync } from "node:fs";
import { createConnection } from "node:net";
import { isAbsolute } from "node:path";

export interface OwnerNotificationClient {
  sendMessage(chatId: number, text: string): Promise<unknown>;
}

export interface OwnerNotificationIngress {
  stop(): Promise<void>;
}

const MAX_TEXT_CHARS = 4096;
const MAX_BODY_BYTES = 16384;
const SOCKET_PROBE_TIMEOUT_MS = 500;

async function isLiveSocket(socketPath: string): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    let settled = false;
    const socket = createConnection({ path: socketPath });
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error(`Timed out probing owner notification socket: ${socketPath}`)));
    }, SOCKET_PROBE_TIMEOUT_MS);

    socket.once("connect", () => finish(() => resolve(true)));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") {
        finish(() => resolve(false));
        return;
      }
      finish(() => reject(error));
    });
  });
}

/**
 * Bounded local ingress for delivering owner-facing notifications through
 * the single interactive Telegram surface. Listens on a Unix socket rather
 * than a network port; there is exactly one configured owner and no way to
 * address any other chat, so this cannot become a general notification bus.
 */
export async function startOwnerNotificationIngress(options: {
  socketPath: string;
  allowedUserIds: Set<string>;
  client: OwnerNotificationClient;
}): Promise<OwnerNotificationIngress> {
  const { socketPath, allowedUserIds, client } = options;

  if (!isAbsolute(socketPath)) {
    throw new Error("Owner notification ingress requires an absolute socket path");
  }
  if (allowedUserIds.size !== 1) {
    throw new Error("Owner notification ingress requires exactly one configured owner");
  }
  const [ownerIdText] = allowedUserIds;
  const ownerId = Number(ownerIdText);
  if (!Number.isSafeInteger(ownerId) || ownerId <= 0) {
    throw new Error("Owner notification ingress requires a numeric Telegram owner id");
  }

  if (existsSync(socketPath)) {
    const stat = lstatSync(socketPath);
    if (!stat.isSocket()) {
      throw new Error(`Refusing to bind owner notification ingress over a non-socket path: ${socketPath}`);
    }
    if (await isLiveSocket(socketPath)) {
      throw new Error(`Refusing to replace an active owner notification socket: ${socketPath}`);
    }
    if (existsSync(socketPath)) unlinkSync(socketPath);
  }

  const server: Server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/notify") {
      res.writeHead(404).end();
      return;
    }

    let body = "";
    let oversized = false;
    req.on("data", (chunk: Buffer) => {
      body += chunk;
      if (!oversized && Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) oversized = true;
    });
    req.on("end", () => {
      if (oversized) {
        res.writeHead(413).end();
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400).end();
        return;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        res.writeHead(400).end();
        return;
      }
      const keys = Object.keys(parsed as Record<string, unknown>);
      if (keys.some((key) => key !== "text")) {
        res.writeHead(400).end();
        return;
      }
      const text = (parsed as { text?: unknown }).text;
      if (typeof text !== "string" || text.length === 0) {
        res.writeHead(400).end();
        return;
      }
      if (text.length > MAX_TEXT_CHARS) {
        res.writeHead(413).end();
        return;
      }

      client.sendMessage(ownerId, text).then(
        () => { res.writeHead(202).end(); },
        () => { res.writeHead(500).end(); },
      );
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    async stop(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try { unlinkSync(socketPath); } catch { /* already removed */ }
    },
  };
}
