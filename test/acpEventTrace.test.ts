import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAcpEventTrace, normalizeAcpTraceJsonl, sanitizeAcpTraceUpdate } from "../src/acp/eventTrace.js";
import { runAcpTurn } from "../src/acp/client.js";
import { createFakeAcpAgent } from "./support/fakeAcpAgent.js";

const env = (directory?: string) => ({
  ...(directory ? { AGENT_BRIDGE_ACP_TRACE_DIR: directory } : {}),
  CODEX_API_KEY: "trace-secret-canary",
});

describe("opt-in ACP event trace", () => {
  it("is absent by default and does not change a normal ACP turn", async () => {
    const root = mkdtempSync(join(tmpdir(), "acp-trace-disabled-"));
    const prior = process.env.AGENT_BRIDGE_ACP_TRACE_DIR;
    delete process.env.AGENT_BRIDGE_ACP_TRACE_DIR;
    try {
      const result = await runAcpTurn({ peer: createFakeAcpAgent(), cwd: process.cwd(), conversationId: "trace-conv", runId: "trace-run", existingAcpSessionId: null, prompt: "hello", executionMode: "safe" });
      expect(result.liveText).toBe("live:hello");
      expect(existsSync(join(root, "trace-run.jsonl"))).toBe(false);
    } finally {
      if (prior === undefined) delete process.env.AGENT_BRIDGE_ACP_TRACE_DIR; else process.env.AGENT_BRIDGE_ACP_TRACE_DIR = prior;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("observes the shared parsed ACP client boundary before normal completion", async () => {
    const root = mkdtempSync(join(tmpdir(), "acp-trace-client-"));
    const prior = process.env.AGENT_BRIDGE_ACP_TRACE_DIR;
    process.env.AGENT_BRIDGE_ACP_TRACE_DIR = root;
    try {
      const result = await runAcpTurn({ peer: createFakeAcpAgent(), cwd: process.cwd(), conversationId: "trace-conv", runId: "trace-client", existingAcpSessionId: null, prompt: "hello", executionMode: "safe" });
      expect(result.liveText).toBe("live:hello");
      const records = readFileSync(join(root, "trace-client.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(records.at(-1)).toMatchObject({ eventClass: "terminal", stopReason: "end_turn" });
      expect(records.some((record) => record.sessionUpdate === "agent_message_chunk" && record.content?.text === "live:hello")).toBe(true);
    } finally {
      if (prior === undefined) delete process.env.AGENT_BRIDGE_ACP_TRACE_DIR; else process.env.AGENT_BRIDGE_ACP_TRACE_DIR = prior;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes exact ordered protocol fragments with only allowlisted metadata", () => {
    const root = mkdtempSync(join(tmpdir(), "acp-trace-"));
    try {
      const trace = createAcpEventTrace("run-one", env(root));
      expect(trace).not.toBeNull();
      trace!.observe("session-one", { sessionUpdate: "agent_message_chunk", messageId: "message-1", content: { type: "text", text: "Hel trace-secret-canary bearer raw-token" }, _meta: { codex: { phase: "commentary" }, secret: "must-not-persist" } });
      trace!.observe("session-one", { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "private-but-visible-class" } });
      trace!.observe("session-one", { sessionUpdate: "tool_call", toolCallId: "call-1", title: "Read file", kind: "read", status: "pending", rawInput: { authorization: "Bearer trace-secret-canary" }, rawOutput: "trace-secret-canary" });
      trace!.observe("session-one", { sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "completed" });
      trace!.observe("session-one", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "lo" } });
      trace!.observe("session-one", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: ", world." } });
      trace!.terminal("session-one", "end_turn");
      const raw = readFileSync(join(root, "run-one.jsonl"), "utf8");
      expect(raw).not.toContain("trace-secret-canary");
      const records = raw.trim().split("\n").map((line) => JSON.parse(line));
      expect(records.map((record) => record.sessionUpdate ?? record.eventClass)).toEqual(["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update", "agent_message_chunk", "agent_message_chunk", "terminal"]);
      expect(records.filter((record) => record.content?.type === "text").map((record) => record.content.text)).toEqual(["Hel [REDACTED_PROVIDER_CREDENTIAL] bearer [REDACTED_CREDENTIAL]", "private-but-visible-class", "lo", ", world."]);
      expect(records[0]).toMatchObject({ messageId: "message-1", meta: { codex: { phase: "commentary" } } });
      expect(records[4]).not.toHaveProperty("messageId");
      expect(records[2]).toMatchObject({ toolCallId: "call-1", toolTitle: "Read file", toolKind: "read", toolStatus: "pending" });
      expect(JSON.stringify(records[2])).not.toContain("rawInput");
      expect(JSON.stringify(records[2])).not.toContain("rawOutput");
      expect(JSON.stringify(records[0])).not.toContain("must-not-persist");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("isolates concurrent runs, ignores trace write errors, and normalizes only nondeterministic ids", () => {
    const root = mkdtempSync(join(tmpdir(), "acp-trace-isolation-"));
    try {
      const one = createAcpEventTrace("run-one", env(root))!;
      const two = createAcpEventTrace("run-two", env(root))!;
      one.observe("session-a", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "one" } });
      two.observe("session-b", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "two" } });
      expect(readFileSync(join(root, "run-one.jsonl"), "utf8")).toContain('"one"');
      expect(readFileSync(join(root, "run-two.jsonl"), "utf8")).toContain('"two"');
      const broken = createAcpEventTrace("run-broken", env(root), {
        mkdirSync: () => undefined,
        openSync: () => { throw new Error("disk full"); },
        closeSync: () => undefined,
        writeSync: () => 0,
      })!;
      expect(() => broken.observe("session", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "unchanged" } })).not.toThrow();
      const a = '{"sequence":1,"eventClass":"session_update","sessionId":"a","toolCallId":"x","content":{"type":"text","text":"Hel"}}\n';
      const b = '{"sequence":1,"eventClass":"session_update","sessionId":"b","toolCallId":"y","content":{"type":"text","text":"Hel"}}\n';
      expect(normalizeAcpTraceJsonl(a)).toBe(normalizeAcpTraceJsonl(b));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("does not serialize arbitrary fields when sanitizing malformed updates", () => {
    const record = sanitizeAcpTraceUpdate(1, "session", { sessionUpdate: "tool_call", raw: { password: "no" }, _meta: { any: "no" } }, env());
    expect(record).toEqual({ sequence: 1, eventClass: "session_update", sessionId: "session", sessionUpdate: "tool_call" });
  });

  it("continues a provider turn when trace setup cannot persist", async () => {
    const root = mkdtempSync(join(tmpdir(), "acp-trace-unwritable-"));
    const prior = process.env.AGENT_BRIDGE_ACP_TRACE_DIR;
    process.env.AGENT_BRIDGE_ACP_TRACE_DIR = join(root, "not-a-directory");
    try {
      // A file at the requested path makes mkdir fail; tracing stays observational.
      writeFileSync(process.env.AGENT_BRIDGE_ACP_TRACE_DIR, "x");
      const result = await runAcpTurn({ peer: createFakeAcpAgent(), cwd: process.cwd(), conversationId: "trace-failure", runId: "trace-failure", existingAcpSessionId: null, prompt: "hello", executionMode: "safe" });
      expect(result.liveText).toBe("live:hello");
    } finally {
      if (prior === undefined) delete process.env.AGENT_BRIDGE_ACP_TRACE_DIR; else process.env.AGENT_BRIDGE_ACP_TRACE_DIR = prior;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
