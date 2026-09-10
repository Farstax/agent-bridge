import type { AcpRetainedEvent } from "../acp/client.js";
import { liveAcpNotificationSessionId, nativeAcpSubagentLifecycle } from "../acp/subagentActivity.js";
import type { RunActivity, RunActivityState } from "../runActivity.js";

type ChildTransition = {
  readonly childKeys: readonly string[];
  readonly state: "spawned" | "working" | "completed" | "failed" | "interrupted";
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function nonEmptyStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const values = value.map(nonEmptyString);
  return values.every((item): item is string => item !== null) ? values : null;
}

/**
 * Interpret only Codex's documented structured ACP extension metadata.
 * rawInput/rawOutput, titles, prompts, paths, and tool content are deliberately ignored.
 */
function codexFallbackTransition(event: AcpRetainedEvent): ChildTransition | null {
  if (event.kind !== "session_update" || event.channel !== "live") return null;
  const update = record(event.notification?.update);
  if (!update || (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update")) return null;
  const meta = record(update._meta);
  const codex = record(meta?.codex);
  if (!codex) return null;

  if (Object.prototype.hasOwnProperty.call(codex, "collaboration")) {
    const collaboration = record(codex.collaboration);
    if (!collaboration || collaboration.tool !== "spawnAgent") return null;
    const childKeys = nonEmptyStringArray(collaboration.receiverThreadIds);
    if (!childKeys) return null;
    return {
      childKeys,
      state: update.status === "failed" ? "failed" : "spawned",
    };
  }

  if (!Object.prototype.hasOwnProperty.call(codex, "subagent")) return null;
  const subagent = record(codex.subagent);
  if (!subagent) return null;
  const childKey = nonEmptyString(subagent.threadId);
  if (!childKey || childKey === event.notification?.sessionId) return null;
  switch (subagent.activity) {
    case "started":
    case "interacted":
      return { childKeys: [childKey], state: "working" };
    case "completed":
      return { childKeys: [childKey], state: "completed" };
    case "interrupted":
      return { childKeys: [childKey], state: "interrupted" };
    default:
      return null;
  }
}

function activity(state: RunActivityState, activeCount: number): RunActivity {
  return { kind: "subagents", state, activeCount };
}

export interface CodexAcpRunActivityProjector {
  observe(event: AcpRetainedEvent): RunActivity | null;
}

/**
 * Normalize native ACP subagent lifecycle first, then Codex's structured tool-call fallback.
 * Returned activity contains only bounded state/count information suitable for presentation.
 */
export function createCodexAcpRunActivityProjector(): CodexAcpRunActivityProjector {
  const active = new Set<string>();
  const working = new Set<string>();

  const apply = (transition: ChildTransition): RunActivity | null => {
    if (transition.state === "spawned") {
      let changed = false;
      for (const childKey of transition.childKeys) {
        if (!active.has(childKey)) {
          active.add(childKey);
          changed = true;
        }
      }
      return changed ? activity("delegated", active.size) : null;
    }

    if (transition.state === "working") {
      let changed = false;
      for (const childKey of transition.childKeys) {
        if (!active.has(childKey)) {
          active.add(childKey);
          changed = true;
        }
        if (!working.has(childKey)) {
          working.add(childKey);
          changed = true;
        }
      }
      return changed ? activity("working", active.size) : null;
    }

    let changed = false;
    for (const childKey of transition.childKeys) {
      if (active.delete(childKey)) changed = true;
      working.delete(childKey);
    }
    if (!changed) return null;
    // A failure/interruption signal must survive while siblings remain
    // active, rather than collapsing to generic "working" and losing it.
    if (transition.state === "failed") return activity("failed", active.size);
    if (transition.state === "interrupted") return activity("interrupted", active.size);
    if (active.size > 0) return activity("working", active.size);
    return activity("reviewing", 0);
  };

  return {
    observe(event) {
      const native = nativeAcpSubagentLifecycle(event);
      if (native) {
        return apply({ childKeys: [native.childKey], state: native.state });
      }

      const fallback = codexFallbackTransition(event);
      if (fallback) return apply(fallback);

      const sessionId = liveAcpNotificationSessionId(event);
      if (!sessionId || !active.has(sessionId) || working.has(sessionId)) return null;
      working.add(sessionId);
      return activity("working", active.size);
    },
  };
}
