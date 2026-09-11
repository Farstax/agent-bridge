import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { parseCliResult } from "../src/cli.js";
import { openDb } from "../src/db.js";
import { EventStore } from "../src/events/store.js";
import { type as eventType } from "../src/events/types.js";
import { acpTurnResultToCliResult } from "../src/providers/acpRuntime.js";
import {
  captureParsedProviderOutput,
  consumePendingRunFallback,
  finalizeRunTelemetry,
  notePendingRunFallback,
  noteRunProviderAttempt,
  registerProviderOutput,
} from "../src/runTelemetry.js";

const AGY_SESSION = "c107dfbd-181e-4cf0-a840-894662adee43";

describe("normalized provider run telemetry", () => {
  it("extracts Claude ACP usage into normalized telemetry", () => {
    const parsed = acpTurnResultToCliResult("claude", {
      liveText: "done",
      acpSessionId: "session-1",
      stopReason: "end_turn",
      usage: {
        inputTokens: 100,
        outputTokens: 25,
        cachedReadTokens: 45,
        thoughtTokens: 10,
      },
    });

    expect(parsed).toEqual({
      text: "done",
      sessionId: "session-1",
      stopReason: "end_turn",
      telemetry: {
        provider: "claude",
        inputTokens: 100,
        outputTokens: 25,
        cachedInputTokens: 45,
        reasoningTokens: 10,
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
    expect(acpTurnResultToCliResult("claude", {
      liveText: "done",
      acpSessionId: "legacy-session",
      stopReason: "end_turn",
    })).toEqual({ text: "done", sessionId: "legacy-session", stopReason: "end_turn" });

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

  it("persists ACP usage telemetry on the durable run.completed event", () => {
    const dbPath = join(tmpdir(), `run-telemetry-acp-${Date.now()}-${Math.random()}.sqlite`);
    const db = openDb(dbPath);
    try {
      const runId = "durable-acp-telemetry-run";
      const text = "ACP live answer";
      noteRunProviderAttempt(runId, "codex", "gpt-5.6-luna");
      registerProviderOutput(runId, "codex", text);
      captureParsedProviderOutput("codex", text, {
        provider: "codex",
        inputTokens: 9,
        outputTokens: 4,
        reasoningTokens: 2,
      });

      const store = new EventStore(db);
      store.collect(eventType.runStarted({
        runId,
        bot: "codex",
        chatId: "100",
        chatKey: "100",
        command: "codex-acp",
        cwd: "/repo",
        model: null,
      }));
      store.queueCompleted(eventType.runCompleted({
        runId,
        bot: "codex",
        chatId: "100",
        chatKey: "100",
        text,
        sessionId: "acp-session",
        telemetry: { provider: "codex", inputTokens: 9, outputTokens: 4, reasoningTokens: 2 },
      }));
      store.finalize();

      const rows = db.getEventsForRun(runId);
      const payload = JSON.parse(rows[1].payload_json);
      expect(payload.telemetry).toMatchObject({
        provider: "codex",
        model: "gpt-5.6-luna",
        inputTokens: 9,
        outputTokens: 4,
        reasoningTokens: 2,
      });
    } finally {
      db.close();
      try { rmSync(dbPath); } catch {}
    }
  });

  it("persists correlated parser telemetry on the durable run.completed event", () => {
    const dbPath = join(tmpdir(), `run-telemetry-${Date.now()}-${Math.random()}.sqlite`);
    const db = openDb(dbPath);
    try {
      const runId = "durable-telemetry-run";
      const stdout = JSON.stringify({
        event: "result",
        result: {
          conversation_id: AGY_SESSION,
          status: "SUCCESS",
          response: "done",
          usage: { input_tokens: 12, output_tokens: 4 },
        },
      });
      noteRunProviderAttempt(runId, "antigravity", "requested-antigravity");
      registerProviderOutput(runId, "antigravity", stdout);
      const parsed = parseCliResult({ bot: "antigravity", stdout, outputFormat: "stream-json" });

      const store = new EventStore(db);
      store.collect(eventType.runStarted({
        runId,
        bot: "antigravity",
        chatId: "100",
        chatKey: "100",
        command: "agy",
        cwd: "/repo",
        model: null,
      }));
      store.queueCompleted(eventType.runCompleted({
        runId,
        bot: "antigravity",
        chatId: "100",
        chatKey: "100",
        text: parsed.text,
        sessionId: parsed.sessionId,
      }));
      store.finalize();

      const rows = db.getEventsForRun(runId);
      expect(rows.map((row: any) => row.type)).toEqual(["run.started", "run.completed"]);
      const payload = JSON.parse(rows[1].payload_json);
      expect(payload.telemetry).toMatchObject({
        provider: "antigravity",
        model: "requested-antigravity",
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
