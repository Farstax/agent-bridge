/**
 * PURPOSE: Portable Slack companion configuration (#943). Tokens come from a
 * file (any secret manager) or an environment value, never both; the
 * allowlist is mandatory and default-deny. Values are never echoed.
 * INPUTS: process environment.
 * OUTPUTS: SlackConfig, SlackConfigError (actionable, secret-free messages).
 * NEIGHBORS: src/index-slack-interactive.ts, src/slackIdentity.ts
 */
import { readFileSync, statSync } from "node:fs";

export class SlackConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlackConfigError";
  }
}

export interface SlackConfig {
  botToken: string;
  appToken: string;
  allowedUserIds: string[];
  statusFile: string | null;
  /** Optional Web API base URL (Slack GovCloud, an egress proxy, or an acceptance harness). */
  apiUrl: string | null;
}

type Env = Record<string, string | undefined>;

function readToken(env: Env, name: "SLACK_BOT_TOKEN" | "SLACK_APP_TOKEN", readFile: (path: string) => string): string {
  const direct = env[name]?.trim();
  const filePath = env[`${name}_FILE`]?.trim();
  if (direct && filePath) throw new SlackConfigError(`${name} and ${name}_FILE are both set; set exactly one.`);
  if (filePath) {
    let content: string;
    try {
      if (!statSync(filePath).isFile()) throw new Error("not a file");
      content = readFile(filePath);
    } catch {
      throw new SlackConfigError(`${name}_FILE is not a readable file.`);
    }
    const token = content.replace(/[\r\n]+$/, "").trim();
    if (!token) throw new SlackConfigError(`${name}_FILE is empty.`);
    return token;
  }
  if (!direct) throw new SlackConfigError(`${name}_FILE (or ${name}) is required.`);
  return direct;
}

export function loadSlackConfig(env: Env = process.env, readFile: (path: string) => string = (p) => readFileSync(p, "utf8")): SlackConfig {
  const botToken = readToken(env, "SLACK_BOT_TOKEN", readFile);
  const appToken = readToken(env, "SLACK_APP_TOKEN", readFile);
  const allowedUserIds = [...new Set((env.SLACK_ALLOWED_USER_IDS ?? "").split(",").map((v) => v.trim()).filter(Boolean))];
  if (allowedUserIds.length === 0) throw new SlackConfigError("SLACK_ALLOWED_USER_IDS must list at least one Slack user ID (default deny).");
  const invalid = allowedUserIds.find((id) => !/^[UW][A-Z0-9]{2,}$/.test(id));
  if (invalid) throw new SlackConfigError("SLACK_ALLOWED_USER_IDS must contain Slack member IDs such as U0123ABCD.");
  const statusFile = env.SLACK_STATUS_FILE?.trim() || null;
  const rawApiUrl = env.SLACK_API_URL?.trim();
  let apiUrl: string | null = null;
  if (rawApiUrl) {
    let parsed: URL;
    try { parsed = new URL(rawApiUrl); } catch { throw new SlackConfigError("SLACK_API_URL is not a valid URL."); }
    const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]";
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
      throw new SlackConfigError("SLACK_API_URL must use https (plain http is allowed only for loopback).");
    }
    apiUrl = parsed.toString().endsWith("/") ? parsed.toString() : `${parsed.toString()}/`;
  }
  return { botToken, appToken, allowedUserIds, statusFile, apiUrl };
}
