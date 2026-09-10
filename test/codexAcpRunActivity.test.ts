import { describe, expect, it } from "vitest";
import { createCodexAcpRunActivityProjector } from "../src/providers/codexAcpRunActivity.js";
import type { AcpRetainedEvent } from "../src/acp/client.js";

function event(update: Record<string, unknown>, channel: "live" | "replay" = "live", sessionId = "root-session"): AcpRetainedEvent {
  return {
    kind: "session_update",
    channel,
    notification: { sessionId, update } as any,
  };
}

describe("Codex ACP run activity projection", () => {
  it("projects native subagent lifecycle without exposing child ids or task text", () => {
    const projector = createCodexAcpRunActivityProjector();
    const childId = "provider-child-secret-123";
    const task = "raw delegated prompt must stay private";

    const delegated = projector.observe(event({
      sessionUpdate: "subagent_spawned",
      subagentSessionId: childId,
      name: "researcher",
      task,
      capabilities: {},
    }));
    const working = projector.observe(event({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "private child output" },
    }, "live", childId));
    const completed = projector.observe(event({
      sessionUpdate: "subagent_state_update",
      subagentSessionId: childId,
      state: "completed",
    }));

    expect(delegated).toEqual({ kind: "subagents", state: "delegated", activeCount: 1 });
    expect(working).toEqual({ kind: "subagents", state: "working", activeCount: 1 });
    expect(completed).toEqual({ kind: "subagents", state: "reviewing", activeCount: 0 });
    const serialized = JSON.stringify([delegated, working, completed]);
    expect(serialized).not.toContain(childId);
    expect(serialized).not.toContain(task);
    expect(serialized).not.toContain("private child output");
  });

  it("uses Codex structured tool metadata as a fallback and bounds multiple-child state", () => {
    const projector = createCodexAcpRunActivityProjector();
    const spawn = (id: string) => event({
      sessionUpdate: "tool_call",
      toolCallId: `spawn-${id}`,
      status: "in_progress",
      _meta: { codex: { collaboration: { tool: "spawnAgent", receiverThreadIds: [id] } } },
      rawInput: { prompt: `secret-${id}`, receiverThreadIds: [id] },
    });
    const activity = (id: string, kind: string) => event({
      sessionUpdate: kind === "started" ? "tool_call" : "tool_call_update",
      toolCallId: `activity-${id}`,
      status: kind === "started" ? "in_progress" : "completed",
      _meta: { codex: { subagent: { threadId: id, path: `root/${id}`, activity: kind } } },
    });

    expect(projector.observe(spawn("child-a"))).toEqual({ kind: "subagents", state: "delegated", activeCount: 1 });
    expect(projector.observe(activity("child-a", "started"))).toEqual({ kind: "subagents", state: "working", activeCount: 1 });
    expect(projector.observe(spawn("child-b"))).toEqual({ kind: "subagents", state: "delegated", activeCount: 2 });
    expect(projector.observe(activity("child-b", "started"))).toEqual({ kind: "subagents", state: "working", activeCount: 2 });
    expect(projector.observe(activity("child-b", "started"))).toBeNull();
    expect(projector.observe(activity("child-a", "completed"))).toEqual({ kind: "subagents", state: "working", activeCount: 1 });
    expect(projector.observe(activity("child-b", "completed"))).toEqual({ kind: "subagents", state: "reviewing", activeCount: 0 });
  });

  it("reports failure/interruption, ignores replay, and fails closed on malformed metadata", () => {
    const failed = createCodexAcpRunActivityProjector();
    failed.observe(event({
      sessionUpdate: "subagent_spawned",
      subagentSessionId: "child-f",
      name: "worker",
      task: "private",
      capabilities: {},
    }));
    expect(failed.observe(event({
      sessionUpdate: "subagent_state_update",
      subagentSessionId: "child-f",
      state: "failed",
    }))).toEqual({ kind: "subagents", state: "failed", activeCount: 0 });

    const interrupted = createCodexAcpRunActivityProjector();
    interrupted.observe(event({
      sessionUpdate: "tool_call",
      toolCallId: "activity-i",
      status: "in_progress",
      _meta: { codex: { subagent: { threadId: "child-i", path: "root/i", activity: "started" } } },
    }));
    expect(interrupted.observe(event({
      sessionUpdate: "tool_call_update",
      toolCallId: "activity-i",
      status: "completed",
      _meta: { codex: { subagent: { threadId: "child-i", path: "root/i", activity: "interrupted" } } },
    }))).toEqual({ kind: "subagents", state: "interrupted", activeCount: 0 });

    const replay = createCodexAcpRunActivityProjector();
    expect(replay.observe(event({
      sessionUpdate: "subagent_spawned",
      subagentSessionId: "replayed-child",
      name: "old",
      task: "old task",
      capabilities: {},
    }, "replay"))).toBeNull();
    expect(replay.observe(event({ sessionUpdate: "tool_call", _meta: { codex: { subagent: "bad" } } }))).toBeNull();
    expect(replay.observe(event({ sessionUpdate: "tool_call", _meta: { codex: { collaboration: { tool: "spawnAgent", receiverThreadIds: [null, 1] } } } }))).toBeNull();
  });

  it("preserves a failure/interruption signal instead of collapsing to generic working when a sibling child remains active", () => {
    const projector = createCodexAcpRunActivityProjector();
    const spawn = (id: string) => event({
      sessionUpdate: "subagent_spawned",
      subagentSessionId: id,
      name: "worker",
      task: "private",
      capabilities: {},
    });
    const state = (id: string, state: string) => event({
      sessionUpdate: "subagent_state_update",
      subagentSessionId: id,
      state,
    });

    projector.observe(spawn("child-a"));
    projector.observe(spawn("child-b"));

    expect(projector.observe(state("child-a", "failed"))).toEqual({
      kind: "subagents",
      state: "failed",
      activeCount: 1,
    });

    const stillInterrupted = createCodexAcpRunActivityProjector();
    stillInterrupted.observe(spawn("child-c"));
    stillInterrupted.observe(spawn("child-d"));

    expect(stillInterrupted.observe(state("child-c", "cancelled"))).toEqual({
      kind: "subagents",
      state: "interrupted",
      activeCount: 1,
    });
  });
});
