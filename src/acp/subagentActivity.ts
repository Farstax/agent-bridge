import type { AcpRetainedEvent } from "./client.js";

export type AcpSubagentLifecycleState = "spawned" | "completed" | "failed" | "interrupted";

export interface AcpSubagentLifecycle {
  readonly childKey: string;
  readonly state: AcpSubagentLifecycleState;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** Decode the draft native ACP subagent lifecycle without depending on provider metadata. */
export function nativeAcpSubagentLifecycle(event: AcpRetainedEvent): AcpSubagentLifecycle | null {
  if (event.kind !== "session_update" || event.channel !== "live") return null;
  const update = record(event.notification?.update);
  if (!update) return null;

  if (update.sessionUpdate === "subagent_spawned") {
    const childKey = nonEmptyString(update.subagentSessionId);
    return childKey ? { childKey, state: "spawned" } : null;
  }

  if (update.sessionUpdate !== "subagent_state_update") return null;
  const childKey = nonEmptyString(update.subagentSessionId);
  if (!childKey) return null;
  switch (update.state) {
    case "completed":
      return { childKey, state: "completed" };
    case "failed":
    case "disconnected":
      return { childKey, state: "failed" };
    case "cancelled":
      return { childKey, state: "interrupted" };
    default:
      return null;
  }
}

/** The notification session identifies native child output after a spawn. */
export function liveAcpNotificationSessionId(event: AcpRetainedEvent): string | null {
  if (event.kind !== "session_update" || event.channel !== "live") return null;
  return nonEmptyString(event.notification?.sessionId);
}
