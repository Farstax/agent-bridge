import { mkdirSync, openSync, closeSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import type { StopReason } from "@agentclientprotocol/sdk";
import { redactProviderApiKeySecrets } from "../providers/apiKeyAuth.js";

/**
 * Opt-in protocol evidence. This deliberately serializes an allowlist rather
 * than attempting to redact a provider update object.
 */
export interface AcpEventTrace {
  observe(sessionId: string, update: unknown): void;
  terminal(sessionId: string, stopReason: StopReason): void;
}

type TraceEnv = Record<string, string | undefined>;
type TraceFs = Pick<typeof import("node:fs"), "mkdirSync" | "openSync" | "closeSync" | "writeSync">;

const SAFE_VALUE = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

function redactTraceText(value: string, env: TraceEnv): string {
  return redactProviderApiKeySecrets(value, env)
    .replace(/\b(bearer)\s+[^\s]+/gi, "$1 [REDACTED_CREDENTIAL]")
    .replace(/\b(access[_-]?token|refresh[_-]?token|authorization)\s*[:=]\s*[^\s,}]+/gi, "$1=[REDACTED_CREDENTIAL]");
}

function codexPhase(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const codex = (value as Record<string, unknown>).codex;
  if (!codex || typeof codex !== "object" || Array.isArray(codex)) return undefined;
  const phase = (codex as Record<string, unknown>).phase;
  return phase === "commentary" || phase === "final_answer" ? phase : undefined;
}

/** Build the sole persisted shape. Unknown fields, tool payloads, and _meta are excluded. */
export function sanitizeAcpTraceUpdate(sequence: number, sessionId: string, update: unknown, env: TraceEnv = process.env): Record<string, unknown> {
  const source = update && typeof update === "object" && !Array.isArray(update)
    ? update as Record<string, unknown>
    : {};
  const record: Record<string, unknown> = {
    sequence,
    eventClass: "session_update",
    sessionId,
    sessionUpdate: SAFE_VALUE(source.sessionUpdate) ?? "unknown",
  };
  const content = source.content;
  if (content && typeof content === "object" && !Array.isArray(content)) {
    const contentSource = content as Record<string, unknown>;
    const type = SAFE_VALUE(contentSource.type);
    if (type) {
      const safeContent: Record<string, unknown> = { type };
      // Text is protocol evidence, except configured provider credentials.
      if (type === "text" && typeof contentSource.text === "string") {
        safeContent.text = redactTraceText(contentSource.text, env);
      }
      record.content = safeContent;
    }
  }
  for (const [sourceKey, outputKey] of [["messageId", "messageId"], ["toolCallId", "toolCallId"], ["title", "toolTitle"], ["kind", "toolKind"], ["status", "toolStatus"]] as const) {
    const value = SAFE_VALUE(source[sourceKey]);
    if (value) record[outputKey] = redactTraceText(value, env);
  }
  const phase = codexPhase(source._meta);
  if (phase) record.meta = { codex: { phase } };
  return record;
}

export function normalizeAcpTraceJsonl(input: string): string {
  const maps = new Map<string, Map<string, string>>();
  const replace = (kind: string, value: unknown): unknown => {
    if (typeof value !== "string") return value;
    const values = maps.get(kind) ?? new Map<string, string>();
    maps.set(kind, values);
    if (!values.has(value)) values.set(value, `<${kind}-${values.size + 1}>`);
    return values.get(value);
  };
  return input.split(/\r?\n/).filter(Boolean).map((line) => {
    const raw = JSON.parse(line) as Record<string, unknown>;
    const record = { ...raw };
    for (const key of ["sessionId", "requestId", "toolCallId"] as const) {
      if (key in record) record[key] = replace(key, record[key]);
    }
    return JSON.stringify(record);
  }).join("\n") + (input.trim() ? "\n" : "");
}

export function createAcpEventTrace(runId: string, env: TraceEnv = process.env, fs: TraceFs = { mkdirSync, openSync, closeSync, writeSync }): AcpEventTrace | null {
  const directory = env.AGENT_BRIDGE_ACP_TRACE_DIR?.trim();
  if (!directory || !/^[-A-Za-z0-9_]{1,128}$/.test(runId)) return null;
  try {
    const root = resolve(directory);
    if (!directory.startsWith("/")) return null;
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    let sequence = 0;
    let initialized = false;
    const write = (record: Record<string, unknown>) => {
      let fd: number | undefined;
      try {
        // The first record creates an exclusive artifact. A collision is
        // observational failure, never permission to append another Run.
        fd = fs.openSync(`${root}/${runId}.jsonl`, initialized ? "a" : "wx", 0o600);
        initialized = true;
        fs.writeSync(fd, `${JSON.stringify(record)}\n`);
      } catch { /* observational only */ } finally {
        if (fd !== undefined) try { fs.closeSync(fd); } catch { /* observational only */ }
      }
    };
    return {
      observe(sessionId, update) { write(sanitizeAcpTraceUpdate(++sequence, sessionId, update, env)); },
      terminal(sessionId, stopReason) { write({ sequence: ++sequence, eventClass: "terminal", sessionId, stopReason }); },
    };
  } catch {
    return null;
  }
}
