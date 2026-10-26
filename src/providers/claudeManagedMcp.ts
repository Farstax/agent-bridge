import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Host-published managed MCP sockets. The workspace helper only writes this adapter shape. */
export const CLAUDE_MANAGED_MCP_SOCKET_DIR = "/run/agent-bridge/managed-mcp";
/** OSS-owned adapter path. The hosted installer must publish the helper here. */
export const CLAUDE_MANAGED_MCP_ADAPTER = "/usr/local/bin/agent-bridge-mcp-adapter.cjs";

export type TrustedClaudeMcpServer =
  | { type: "stdio"; command: "node"; args: [string, "--socket", string] }
  | { type: "http"; url: string };

/** A server the owner's agent registered itself (for example `claude mcp add`). */
export type WorkspaceClaudeMcpServer =
  | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { type: "http" | "sse"; url: string; headers?: Record<string, string> };

export type ClaudeMcpServer = TrustedClaudeMcpServer | WorkspaceClaudeMcpServer;

export interface ClaudeMcpContext {
  /** Run working directory; selects the local-scope project entry. */
  cwd?: string;
  executionMode?: "safe" | "trusted";
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

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

function stringMap(value: unknown, maxEntries: number, keyPattern?: RegExp): Record<string, string> | null | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > maxEntries) return null;
  for (const [key, item] of entries) {
    if (typeof item !== "string" || key.length > 256 || item.length > 8192 || (keyPattern && !keyPattern.test(key))) return null;
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

/**
 * Validate a server registered by the agent in Claude's own user/local scope.
 * Only well-formed stdio and http/sse shapes pass; anything else is dropped.
 */
function workspaceClaudeMcpServer(value: unknown): WorkspaceClaudeMcpServer | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.url === "string") {
    if ("command" in entry || "args" in entry || "env" in entry) return null;
    if (entry.type !== undefined && entry.type !== "http" && entry.type !== "sse") return null;
    const remote = trustedHttpServer(entry.url);
    const headers = stringMap(entry.headers, 32);
    if (!remote || remote.type !== "http" || headers === null) return null;
    return { type: entry.type === "sse" ? "sse" : "http", url: remote.url, ...(headers ? { headers } : {}) };
  }
  if (entry.type !== undefined && entry.type !== "stdio") return null;
  if ("url" in entry || "headers" in entry) return null;
  if (typeof entry.command !== "string" || !entry.command.trim() || entry.command.length > 512 || entry.command.includes("\0")) return null;
  let args: string[] | undefined;
  if (entry.args !== undefined) {
    if (!Array.isArray(entry.args) || entry.args.length > 64 || entry.args.some((arg) => typeof arg !== "string" || arg.length > 4096 || arg.includes("\0"))) return null;
    args = entry.args as string[];
  }
  const env = stringMap(entry.env, 64, ENV_NAME);
  if (env === null) return null;
  return { type: "stdio", command: entry.command, ...(args ? { args } : {}), ...(env ? { env } : {}) };
}

function workspaceClaudeMcpServers(raw: unknown): Record<string, WorkspaceClaudeMcpServer> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const servers: Record<string, WorkspaceClaudeMcpServer> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!CONNECTION_NAME.test(name)) continue;
    const server = workspaceClaudeMcpServer(value);
    if (server) servers[name] = server;
  }
  return servers;
}

function sameDirectory(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/**
 * Read the Claude MCP map for a Run. Bridge-managed servers always pass. In a
 * trusted Run the agent's own user-scope and this cwd's local-scope entries from
 * ~/.claude.json also pass, so a server it set up itself is usable. Safe Runs
 * never start agent-registered servers (starting one is execution), and a
 * repository-committed .mcp.json is never read: a cloned repo must not be able
 * to start commands. Tool calls still go through Bridge's permission decision.
 * Missing or unreadable files yield no servers.
 */
export function loadProjectedClaudeMcpServers(
  env: Record<string, string | undefined>,
  context: ClaudeMcpContext = {},
): Record<string, ClaudeMcpServer> {
  const home = env.HOME?.trim() || homedir();
  try {
    const parsed = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")) as {
      mcpServers?: unknown;
      projects?: Record<string, { mcpServers?: unknown } | undefined>;
    };
    const managed = trustedClaudeMcpServers(parsed?.mcpServers);
    if (context.executionMode !== "trusted") return managed;
    const local = context.cwd && parsed?.projects && typeof parsed.projects === "object"
      ? Object.entries(parsed.projects).find(([path]) => sameDirectory(path, context.cwd!))?.[1]?.mcpServers
      : undefined;
    // Bridge-managed names win; later (more specific) scopes win among workspace entries.
    return { ...workspaceClaudeMcpServers(parsed?.mcpServers), ...workspaceClaudeMcpServers(local), ...managed };
  } catch {
    return {};
  }
}
