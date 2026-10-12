import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Host-published managed MCP sockets. The workspace helper only writes this adapter shape. */
export const CLAUDE_MANAGED_MCP_SOCKET_DIR = "/run/agent-bridge/managed-mcp";
export const CLAUDE_MANAGED_MCP_ADAPTER = "/usr/local/bin/farstax-mcp-adapter.cjs";

export type TrustedClaudeMcpServer =
  | { type: "stdio"; command: "node"; args: [string, "--socket", string] }
  | { type: "http"; url: string };

const CONNECTION_NAME = /^[A-Za-z0-9._-]{1,128}$/;
const SOCKET_NAME = /^[A-Za-z0-9._-]{1,160}$/;

/**
 * Keep only MCP servers the workspace projection helper can write.
 * File-backed Claude settings stay disabled; this set is passed explicitly.
 * Arbitrary commands, environments, headers, and credentialed URLs are dropped.
 */
export function trustedClaudeMcpServers(raw: unknown): Record<string, TrustedClaudeMcpServer> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const servers: Record<string, TrustedClaudeMcpServer> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!CONNECTION_NAME.test(name)) continue;
    const server = trustedClaudeMcpServer(value);
    if (server) servers[name] = server;
  }
  return servers;
}

function trustedClaudeMcpServer(value: unknown): TrustedClaudeMcpServer | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if ("env" in entry || "headers" in entry) return null;
  if (typeof entry.url === "string" && !("command" in entry) && !("args" in entry)) {
    return trustedHttpServer(entry.url);
  }
  if (entry.command !== "node" || !Array.isArray(entry.args) || entry.args.length !== 3) return null;
  const [adapter, flag, socket] = entry.args;
  if (adapter !== CLAUDE_MANAGED_MCP_ADAPTER || flag !== "--socket" || typeof socket !== "string") return null;
  const prefix = `${CLAUDE_MANAGED_MCP_SOCKET_DIR}/`;
  if (!socket.startsWith(prefix)) return null;
  const socketName = socket.slice(prefix.length);
  if (!SOCKET_NAME.test(socketName)) return null;
  return { type: "stdio", command: "node", args: [adapter, "--socket", socket] };
}

function trustedHttpServer(value: string): TrustedClaudeMcpServer | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  return { type: "http", url: url.toString() };
}

/** Read the projected Claude MCP map. Missing or unreadable files yield no servers. */
export function loadProjectedClaudeMcpServers(env: Record<string, string | undefined>): Record<string, TrustedClaudeMcpServer> {
  const home = env.HOME?.trim() || homedir();
  try {
    const parsed = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")) as { mcpServers?: unknown };
    return trustedClaudeMcpServers(parsed?.mcpServers);
  } catch {
    return {};
  }
}
