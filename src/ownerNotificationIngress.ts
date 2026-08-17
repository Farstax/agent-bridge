import { createServer, type Server } from "node:http";
import { existsSync, lstatSync, unlinkSync } from "node:fs";
import { isAbsolute } from "node:path";

export interface OwnerNotificationClient {
  sendMessage(chatId: number, text: string): Promise<unknown>;
}

export interface OwnerNotificationIngress {
  stop(): Promise<void>;
}

const MAX_TEXT_CHARS = 4096;
const MAX_BODY_BYTES = 16384;

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

  if (existsSync(socketPath)) {
    const stat = lstatSync(socketPath);
    if (!stat.isSocket()) {
      throw new Error(`Refusing to bind owner notification ingress over a non-socket path: ${socketPath}`);
    }
    // A prior process's stale socket file; nothing is listening on it. Safe to unlink and rebind.
    unlinkSync(socketPath);
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
      // The ingress delivers only to the sole configured owner; it does not
      // accept a target field of any kind.
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
