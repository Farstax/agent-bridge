import * as acp from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import { runAcpTurn } from "../src/acp/client.js";
import {
  createClaudeAcpAnswerPreview,
  detectClaudeAcpTurnError,
} from "../src/providers/claudeAcpPolicy.js";
import {
  classifyProviderError,
  isClaudeOAuthRefreshContention,
} from "../src/providers/errorClassification.js";
import {
  CLAUDE_OAUTH_REFRESH_RETRY_DELAY_MS,
  runWithAcpTransientRetry,
} from "../src/providers/acpTransientRetry.js";

const refreshContention =
  "Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh.";

function systemErrorAgent(diagnostic: string): acp.AgentApp {
  return acp.agent({ name: "system-error-agent" })
    .onRequest(acp.methods.agent.initialize, async () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {},
    }))
    .onRequest(acp.methods.agent.session.new, async () => ({ sessionId: "acp-system-error" }))
    .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: {
          sessionUpdate: "session_info_update",
          threadStatus: { type: "systemError" },
        } as any,
      });
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: diagnostic },
        },
      });
      return { stopReason: "end_turn" };
    });
}

function claudeMessageEvent(text: string): any {
  return {
    kind: "session_update",
    channel: "live",
    acpSessionId: "claude-session",
    sessionMode: "fresh",
    notification: {
      sessionId: "claude-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    },
  };
}

describe("ACP provider failure handling", () => {
  it("turns an in-band ACP systemError into a provider error before answer reconciliation", async () => {
    const retained: any[] = [];
    const liveText: string[] = [];
    let thrown: unknown;

    try {
      await runAcpTurn({
        peer: systemErrorAgent("You've hit your usage limit. Try again at 1:48 PM."),
        cwd: process.cwd(),
        conversationId: "conv-system-error",
        runId: "run-system-error",
        existingAcpSessionId: null,
        prompt: "hello",
        executionMode: "trusted",
        onLiveText: (text) => liveText.push(text),
        onEvent: (event) => retained.push(event),
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).name).toBe("AcpSystemError");
    expect((thrown as Error).message).toContain("usage limit");
    expect(classifyProviderError("codex", thrown as Error)).toMatchObject({ kind: "capacity_exhausted" });
    expect(liveText).toEqual([]);
    expect(retained.some((event) => event.notification?.update?.sessionUpdate === "session_info_update")).toBe(true);
    expect(retained.some((event) => event.presentationSuppressed === true
      && event.notification?.update?.sessionUpdate === "agent_message_chunk")).toBe(true);
  });

  it("keeps an unknown ACP systemError fail-closed rather than promoting its text to an answer", async () => {
    let thrown: unknown;
    try {
      await runAcpTurn({
        peer: systemErrorAgent("provider had an unclassified internal condition"),
        cwd: process.cwd(),
        conversationId: "conv-system-error-unknown",
        runId: "run-system-error-unknown",
        existingAcpSessionId: null,
        prompt: "hello",
        executionMode: "trusted",
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(classifyProviderError("codex", thrown as Error)).toMatchObject({ kind: "unknown" });
  });

  it("classifies Claude OAuth refresh contention as transient in direct and structured error shapes", () => {
    const direct = new Error(refreshContention);
    const structured = Object.assign(new Error("Internal error"), {
      data: { message: refreshContention },
    });

    for (const error of [direct, structured]) {
      expect(isClaudeOAuthRefreshContention(error)).toBe(true);
      expect(classifyProviderError("claude", error)).toMatchObject({ kind: "transient" });
    }
  });

  it("converts Claude's in-band synthetic refresh message into a retryable execution error", () => {
    const error = detectClaudeAcpTurnError({
      liveText: refreshContention,
    } as any);
    expect(error).toBeInstanceOf(Error);
    expect(isClaudeOAuthRefreshContention(error!)).toBe(true);

    expect(detectClaudeAcpTurnError({ liveText: "ordinary Claude answer" } as any)).toBeNull();
  });

  it("keeps Claude refresh contention out of provisional answer previews, including split chunks", () => {
    const chunks: string[] = [];
    const preview = createClaudeAcpAnswerPreview((text) => chunks.push(text), []);
    preview.observe(claudeMessageEvent("Failed to refresh OAuth token: another Claude Code process is "));
    preview.observe(claudeMessageEvent("refreshing it or exited mid-refresh. This is usually transient."));
    preview.finish("end_turn");
    expect(chunks).toEqual([]);

    const ordinary: string[] = [];
    const normalPreview = createClaudeAcpAnswerPreview((text) => ordinary.push(text), []);
    normalPreview.observe(claudeMessageEvent("Final answer"));
    normalPreview.finish("end_turn");
    expect(ordinary.join("")).toBe("Final answer");
  });

  it("retries Claude OAuth refresh contention once after a bounded delay", async () => {
    const wait = vi.fn(async () => {});
    const operation = vi.fn()
      .mockRejectedValueOnce(new Error(refreshContention))
      .mockResolvedValueOnce("ok");

    await expect(runWithAcpTransientRetry("claude", operation, {
      wait,
      abortRequested: () => false,
    })).resolves.toBe("ok");

    expect(operation).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledTimes(1);
    expect(wait).toHaveBeenCalledWith(CLAUDE_OAUTH_REFRESH_RETRY_DELAY_MS, expect.any(Function));
  });

  it("does not retry unrelated Claude failures or retry after cancellation wins", async () => {
    const unrelated = vi.fn().mockRejectedValue(new Error("Authentication required: please log in"));
    await expect(runWithAcpTransientRetry("claude", unrelated, {
      wait: vi.fn(async () => {}),
      abortRequested: () => false,
    })).rejects.toThrow(/Authentication required/);
    expect(unrelated).toHaveBeenCalledTimes(1);

    let abort = false;
    const operation = vi.fn().mockRejectedValue(new Error(refreshContention));
    const wait = vi.fn(async (_delay: number, _abortRequested: () => boolean) => {
      abort = true;
    });
    await expect(runWithAcpTransientRetry("claude", operation, {
      wait,
      abortRequested: () => abort,
    })).rejects.toThrow(/cancelled before transient retry/i);
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
