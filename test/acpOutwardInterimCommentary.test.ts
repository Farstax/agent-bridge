import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type * as acp from "@agentclientprotocol/sdk/unstable";
import { openDb } from "../src/db.js";
import type { SurfaceNeutralTurnInput } from "../src/engine.js";
import { OutwardAcpSessionRepository } from "../src/repositories/outwardAcpSessionRepository.js";
import { BridgeOutwardAcpPromptExecutor } from "../src/acpServer/execution.js";

type Update = acp.SessionNotification["update"];
const META = "agent-bridge/interim-commentary";
type Body = (input: SurfaceNeutralTurnInput) => Promise<{ text: string; sessionId: string; stopReason?: string }>;

async function run(body: Body, options: { interimCommentary?: boolean; abort?: AbortController } = {}) {
  const root = mkdtempSync(join(tmpdir(), "agent-bridge-interim-"));
  const db = openDb(join(root, "bridge.sqlite"), { databaseRole: "interactive" });
  try {
    const session = new OutwardAcpSessionRepository(db.raw).create({ sessionId: "interim-session", conversationId: "acp:interim", cwd: root });
    const updates: Update[] = [];
    const executor = new BridgeOutwardAcpPromptExecutor({
      db, providerChain: ["codex"] as const, runId: () => "run-interim",
      createEngine: () => ({ executeSurfaceNeutralTurn: async (input) => await body(input) }),
    });
    const response = await executor.execute({
      session, prompt: "work", signal: (options.abort ?? new AbortController()).signal,
      ...(options.interimCommentary === undefined ? {} : { interimCommentary: options.interimCommentary }),
      onUpdate: (update) => { updates.push(update); },
    });
    return { response, updates };
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
}
const signals = (updates: Update[]) => updates.flatMap((update) => {
  const meta = (update as { _meta?: Record<string, unknown> })._meta;
  return meta && META in meta ? [meta[META]] : [];
});
const done = { text: "Final answer text.", sessionId: "provider-session", stopReason: "end_turn" };

describe("outward ACP interim commentary delivery", () => {
  it("passes no callback to the engine unless the client opted in", async () => {
    const seen: Array<boolean> = [];
    const body: Body = async (input) => { seen.push(typeof input.onInterimCommentary === "function"); return done; };
    await run(body);
    await run(body, { interimCommentary: false });
    await run(body, { interimCommentary: true });
    expect(seen).toEqual([false, false, true]);
  });

  it("forwards commentary as empty, metadata-only chunks and clears at settle, never as assistant text", async () => {
    const { response, updates } = await run(async (input) => {
      input.onInterimCommentary?.({ id: "1", text: "Reading the router configuration." });
      return done;
    }, { interimCommentary: true });
    expect(response.stopReason).toBe("end_turn");
    expect(signals(updates)).toEqual([{ id: "1", text: "Reading the router configuration." }, { clear: 1 }]);
    for (const update of updates.filter((item) => signals([item]).length)) {
      expect(update).toMatchObject({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" } });
    }
  });

  it("clears on a new provider attempt and on cancellation so stale commentary cannot outlive an attempt", async () => {
    const { updates } = await run(async (input) => {
      input.onInterimCommentary?.({ id: "1", text: "First attempt work." });
      input.onProviderExecutionStarted?.();
      input.onInterimCommentary?.({ id: "1", text: "Second attempt work." });
      return { text: "", sessionId: "provider-session", stopReason: "cancelled" };
    }, { interimCommentary: true });
    expect(signals(updates)).toEqual([
      { id: "1", text: "First attempt work." }, { clear: 1 },
      { id: "1", text: "Second attempt work." }, { clear: 1 },
    ]);
  });

  it("emits nothing after Stop was requested", async () => {
    const abort = new AbortController();
    const { updates } = await run(async (input) => {
      abort.abort();
      input.onInterimCommentary?.({ id: "1", text: "Too late." });
      return { text: "", sessionId: "provider-session", stopReason: "cancelled" };
    }, { interimCommentary: true, abort });
    expect(signals(updates)).toEqual([]);
  });

  it("clears commentary on a provider recovery decision", async () => {
    const { updates } = await run(async (input) => {
      input.onInterimCommentary?.({ id: "1", text: "Working on it." });
      input.onProviderRecoveryDecision?.("capacity", false);
      return done;
    }, { interimCommentary: true });
    expect(signals(updates)).toEqual([{ id: "1", text: "Working on it." }, { clear: 1 }]);
  });
});
