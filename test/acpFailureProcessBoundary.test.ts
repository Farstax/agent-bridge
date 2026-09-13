import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.js";
import { EventStore } from "../src/events/store.js";
import {
  runResolvedAcpProviderTurn,
  type AcpProviderPolicy,
  type ResolvedProviderRuntime,
} from "../src/providers/acpRuntime.js";
import type { ProviderInvocationRequest } from "../src/providers/types.js";

const fixture = fileURLToPath(new URL("./support/systemErrorAcpAgent.ts", import.meta.url));

const policy: AcpProviderPolicy = {
  providerId: "codex",
  registryAgentId: "codex-acp",
  presentation: { provisionalAnswers: true },
};

const runtime: ResolvedProviderRuntime = {
  providerId: "codex",
  transport: "acp-stdio",
  executable: process.execPath,
  args: [join(process.cwd(), "node_modules/tsx/dist/cli.mjs"), fixture],
  versionArgs: ["--version"],
  runtimeIdentity: "test:codex-system-error",
  selectedVersion: "test",
  registryAgentId: "codex-acp",
  distribution: null,
  toolFree: false,
  provisionalAnswers: true,
};

const request: ProviderInvocationRequest = {
  prompt: "trigger in-band system error",
  sessionId: null,
  command: "codex-acp",
  model: null,
  executionMode: "trusted",
  outputFormat: "json",
  soulContext: null,
  includeResponseContract: false,
  attachments: [],
  outputDir: null,
  effort: null,
  toolMode: "default",
};

describe("ACP failure process boundary", () => {
  it("persists the real system error diagnostic and never previews it as answer text", async () => {
    const db = openDb(":memory:");
    const store = new EventStore(db);
    const progress: string[] = [];
    const preview: string[] = [];
    try {
      await expect(runResolvedAcpProviderTurn(
        policy,
        runtime,
        request,
        process.cwd(),
        {
          timeoutMs: 5_000,
          idleTimeoutMs: 5_000,
          chatId: "acp-system-error-process",
          onProgress: (text) => progress.push(text),
          onAnswerDelta: (text) => preview.push(text),
          eventContext: {
            runId: "run-system-error-process",
            bot: "codex",
            chatId: "chat-system-error-process",
            chatKey: "chat-system-error-process:86",
            threadId: "86",
          },
          onEvent: (event) => store.collect(event),
        },
        { conversationId: "conv-system-error-process", runId: "run-system-error-process" },
      )).rejects.toThrow(/usage limit/i);

      expect(progress).toEqual([]);
      expect(preview).toEqual([]);

      const rows = db.getEventsForRun("run-system-error-process");
      const retained = rows
        .filter((row) => row.type === "acp.event")
        .map((row) => JSON.parse(row.payload_json));
      expect(retained.some((event) =>
        event.event?.notification?.update?.sessionUpdate === "session_info_update"
        && event.event?.notification?.update?.threadStatus?.type === "systemError"
      )).toBe(true);
      expect(retained.some((event) =>
        event.event?.presentationSuppressed === true
        && event.event?.notification?.update?.sessionUpdate === "agent_message_chunk"
      )).toBe(true);

      const diagnosticRow = rows.find((row) => row.type === "run.diagnostic");
      expect(diagnosticRow).toBeDefined();
      expect(JSON.parse(diagnosticRow!.payload_json)).toMatchObject({
        type: "run.diagnostic",
        runId: "run-system-error-process",
        bot: "codex",
        chatKey: "chat-system-error-process:86",
        threadId: "86",
        boundary: "provider_execution",
        classification: "capacity_exhausted",
        fallbackEligible: true,
      });
      expect(diagnosticRow!.payload_json).toContain("usage limit");
    } finally {
      db.close();
    }
  }, 15_000);
});
