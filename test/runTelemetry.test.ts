import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { parseCliResult } from "../src/cli.js";
import { openDb } from "../src/db.js";
import { EventStore } from "../src/events/store.js";
import { type as eventType } from "../src/events/types.js";
import {
  consumePendingRunFallback,
  finalizeRunTelemetry,
  notePendingRunFallback,
  noteRunProviderAttempt,
  registerProviderOutput,
} from "../src/runTelemetry.js";

const AGY_SESSION = "c107dfbd-181e-4cf0-a840-894662adee43";

describe("normalized provider run telemetry", () => {
  it("extracts only supported Codex token categories", () => {
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } }),
      JSON.stringify({
        type: "turn.completed",
        usage: {
          input_tokens: 120,
          cached_input_tokens: 40,
          output_tokens: 30,
          reasoning_output_tokens: 7,
          cache_write_input_tokens: 999,
          raw_secret: "must-not-survive",
        },
      }),
    ].join("\n");

    expect(parseCliResult({ bot: "codex", stdout })).toEqual({
      text: "done",
      sessionId: "thread-1",
      telemetry: {
        provider: "codex",
        inputTokens: 120,
        cachedInputTokens: 40,
        outputTokens: 30,
        reasoningTokens: 7,
      },
    });
  });

  it("extracts Claude usage while allowlisting tool counters", () => {
    const stdout = JSON.stringify({
      type: "result",
      result: "done",
      session_id: "session-1",
      duration_ms: 2500,
      duration_api_ms: 1800,
      num_turns: 3,
      total_cost_usd: 0.0123,
      stop_reason: "end_turn",
      terminal_reason: "completed",
      modelUsage: { "claude-sonnet-4-6": { inputTokens: 1 } },
      usage: {
        input_tokens: 100,
        cache_creation_input_tokens: 15,
        cache_read_input_tokens: 45,
        output_tokens: 25,
        service_tier: "standard",
        server_tool_use: { web_search_requests: 2, secret_numeric_field: 999 },
      },
    });

    expect(parseCliResult({ bot: "claude", stdout })).toEqual({
      text: "done",
      sessionId: "session-1",
      telemetry: {
        provider: "claude",
        model: "claude-sonnet-4-6",
        inputTokens: 100,
        cachedInputTokens: 45,
        cacheCreationInputTokens: 15,
        outputTokens: 25,
        costUsd: 0.0123,
        providerDurationMs: 2500,
        providerApiDurationMs: 1800,
        turns: 3,
        stopReason: "end_turn",
        terminalReason: "completed",
        serviceTier: "standard",
        toolUseCounts: { web_search_requests: 2 },
      },
    });
  });

  it("extracts Agy structured usage and ignores unknown fields", () => {
    const stdout = JSON.stringify({
      event: "result",
      result: {
        conversation_id: AGY_SESSION,
        status: "SUCCESS",
        response: "done",
        model: "Gemini 3.5 Flash (High)",
        duration_ms: 1400,
        stop_reason: "completed",
        usage: {
          input_tokens: 90,
          cache_read_tokens: 30,
          output_tokens: 20,
          thinking_tokens: 6,
          prompt_text: "must-not-survive",
        },
      },
    });

    expect(parseCliResult({ bot: "antigravity", stdout, outputFormat: "stream-json" })).toEqual({
      text: "done",
      sessionId: AGY_SESSION,
      telemetry: {
        provider: "antigravity",
        model: "Gemini 3.5 Flash (High)",
        inputTokens: 90,
        cachedInputTokens: 30,
        outputTokens: 20,
        reasoningTokens: 6,
        providerDurationMs: 1400,
        stopReason: "completed",
      },
    });
  });

  it("preserves legacy parser shapes when telemetry is absent", () => {
    expect(parseCliResult({
      bot: "claude",
      stdout: JSON.stringify({ type: "result", result: "done", session_id: "legacy-session" }),
    })).toEqual({ text: "done", sessionId: "legacy-session" });

    expect(parseCliResult({
      bot: "antigravity",
      outputFormat: "stream-json",
      stdout: JSON.stringify({
        event: "result",
        result: { conversation_id: AGY_SESSION, status: "SUCCESS", response: "done" },
      }),
    })).toEqual({ text: "done", sessionId: AGY_SESSION });
  });

  it("keeps provider-reported actual model authoritative", () => {
    noteRunProviderAttempt("actual-model-run", "codex", "requested-model", 1_000);
    expect(finalizeRunTelemetry(
      "actual-model-run",
      "codex",
      { provider: "codex", model: "actual-model", inputTokens: 1 },
      1_100,
    )).toMatchObject({
      provider: "codex",
      model: "actual-model",
      inputTokens: 1,
      durationMs: 100,
    });
  });

  it("persists correlated parser telemetry on the durable run.completed event", () => {
    const dbPath = join(tmpdir(), `run-telemetry-${Date.now()}-${Math.random()}.sqlite`);
    const db = openDb(dbPath);
    try {
      const runId = "durable-telemetry-run";
      const stdout = [
        JSON.stringify({ type: "thread.started", thread_id: "thread-durable" }),
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } }),
        JSON.stringify({ type: "turn.completed", usage: { input_tokens: 12, output_tokens: 4 } }),
      ].join("\n");
      noteRunProviderAttempt(runId, "codex", "requested-codex");
      registerProviderOutput(runId, "codex", stdout);
      const parsed = parseCliResult({ bot: "codex", stdout });

      const store = new EventStore(db);
      store.collect(eventType.runStarted({
        runId,
        bot: "codex",
        chatId: "100",
        command: "codex",
        cwd: "/repo",
        model: null,
      }));
      store.queueCompleted(eventType.runCompleted({
        runId,
        bot: "codex",
        chatId: "100",
        text: parsed.text,
        sessionId: parsed.sessionId,
      }));
      store.finalize();

      const rows = db.getEventsForRun(runId);
      expect(rows.map((row: any) => row.type)).toEqual(["run.started", "run.completed"]);
      const payload = JSON.parse(rows[1].payload_json);
      expect(payload.telemetry).toMatchObject({
        provider: "codex",
        model: "requested-codex",
        inputTokens: 12,
        outputTokens: 4,
      });
      expect(payload.telemetry).not.toHaveProperty("totalTokens");
    } finally {
      db.close();
      try { rmSync(dbPath); } catch {}
    }
  });

  it("records interactive fallback and successful actual model", () => {
    notePendingRunFallback("fallback-chat", {
      fromProvider: "claude",
      toProvider: "codex",
      fromModel: null,
      toModel: null,
      attempt: 1,
    });
    consumePendingRunFallback("fallback-run", "fallback-chat", "codex");
    noteRunProviderAttempt("fallback-run", "codex", "requested-codex", 1_000);

    expect(finalizeRunTelemetry(
      "fallback-run",
      "codex",
      { provider: "codex", model: "actual-codex", outputTokens: 4 },
      1_300,
    )).toEqual({
      provider: "codex",
      model: "actual-codex",
      outputTokens: 4,
      durationMs: 300,
      retryCount: 1,
      fallback: {
        fromProvider: "claude",
        toProvider: "codex",
        fromModel: null,
        toModel: "actual-codex",
        attempt: 1,
      },
    });
  });

  it("chains multi-provider fallback and drops stale provenance", () => {
    notePendingRunFallback("multi-hop-chat", {
      fromProvider: "codex",
      toProvider: "claude",
      fromModel: null,
      toModel: null,
      attempt: 1,
    });
    consumePendingRunFallback("abandoned-run", "multi-hop-chat", "claude");
    notePendingRunFallback("multi-hop-chat", {
      fromProvider: "claude",
      toProvider: "antigravity",
      fromModel: null,
      toModel: null,
      attempt: 1,
    });
    consumePendingRunFallback("successful-run", "multi-hop-chat", "antigravity");
    noteRunProviderAttempt("successful-run", "antigravity", "agy-model", 2_000);
    expect(finalizeRunTelemetry("successful-run", "antigravity", undefined, 2_100).fallback).toEqual({
      fromProvider: "codex",
      toProvider: "antigravity",
      fromModel: null,
      toModel: "agy-model",
      attempt: 2,
    });

    notePendingRunFallback("stale-chat", {
      fromProvider: "claude",
      toProvider: "codex",
      fromModel: null,
      toModel: null,
      attempt: 1,
    });
    consumePendingRunFallback("reset-run", "stale-chat", "claude");
    noteRunProviderAttempt("reset-run", "claude", "claude-model", 3_000);
    expect(finalizeRunTelemetry("reset-run", "claude", undefined, 3_100)).not.toHaveProperty("fallback");
  });
});
