import * as acp from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import { runAcpTurn } from "../src/acp/client.js";
import {
  classifyProviderError,
  isClaudeOAuthRefreshContention,
} from "../src/providers/errorClassification.js";
import {
  CLAUDE_OAUTH_REFRESH_RETRY_DELAY_MS,
  runWithAcpTransientRetry,
} from "../src/providers/acpTransientRetry.js";

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

  it("classifies Claude OAuth refresh contention as transient", () => {
    const error = new Error(
      "Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh.",
    );
    expect(isClaudeOAuthRefreshContention(error)).toBe(true);
    expect(classifyProviderError("claude", error)).toMatchObject({ kind: "transient" });
  });

  it("retries Claude OAuth refresh contention once after a bounded delay", async () => {
    const wait = vi.fn(async () => {});
    const operation = vi.fn()
      .mockRejectedValueOnce(new Error(
        "Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh.",
      ))
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
    const operation = vi.fn().mockRejectedValue(new Error(
      "Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh.",
    ));
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
