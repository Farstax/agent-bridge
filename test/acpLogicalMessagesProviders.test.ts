import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { SessionNotification, SessionUpdate } from "@agentclientprotocol/sdk/unstable";
import { createLogicalPreviewTextStream, reconstructLogicalMessages, renderLogicalMessages } from "../src/acp/logicalMessages.js";
import { liveDeliveryText, type AcpObservedUpdate } from "../src/acp/replay.js";
import type { AcpRetainedEvent } from "../src/acp/client.js";
import { createCodexAcpAnswerPreview } from "../src/providers/codexAcpAnswerPreview.js";
import { createClaudeAcpAnswerPreview } from "../src/providers/claudeAcpPolicy.js";
import { createGrokAcpAnswerPreview, selectGrokAcpAnswer } from "../src/providers/grokAcpPolicy.js";
import { selectCodexAcpAnswer } from "../src/providers/codexAcpPolicy.js";
import type { AcpTurnResult } from "../src/acp/client.js";

const directory = fileURLToPath(new URL("./fixtures/acp-logical-messages/", import.meta.url));
type Fixture = { provider: string; updates: SessionUpdate[]; expected: string };
const fixtures = readdirSync(directory).filter((name) => name.endsWith(".json"))
  .map((name) => JSON.parse(readFileSync(join(directory, name), "utf8")) as Fixture);

const observed = (updates: SessionUpdate[]): AcpObservedUpdate[] =>
  updates.map((update) => ({ channel: "live", notification: { sessionId: "root", update } as SessionNotification }));
const retained = (update: SessionUpdate): AcpRetainedEvent => ({
  kind: "session_update",
  channel: "live",
  acpSessionId: "root",
  notification: { sessionId: "root", update } as SessionNotification,
});

describe("provider-shaped fixtures", () => {
  it("covers Codex, Claude, Grok, Cursor and Agy", () => {
    expect(fixtures.map((fixture) => fixture.provider).sort()).toEqual(["agy", "claude", "codex", "cursor", "grok"]);
  });

  for (const fixture of fixtures.filter((entry) => entry.provider !== "codex")) {
    it(`${fixture.provider}: replay, terminal and standard preview agree`, () => {
      expect(liveDeliveryText(observed(fixture.updates), "root")).toBe(fixture.expected);
      expect(renderLogicalMessages(reconstructLogicalMessages(fixture.updates))).toBe(fixture.expected);
      const next = createLogicalPreviewTextStream();
      expect(fixture.updates.map((update) => next(update)).join("")).toBe(fixture.expected);
    });
  }

  it("claude: live preview output matches terminal text", () => {
    const fixture = fixtures.find((entry) => entry.provider === "claude")!;
    const out: string[] = [];
    const preview = createClaudeAcpAnswerPreview((text) => out.push(text), []);
    for (const update of fixture.updates) preview.observe(retained(update));
    preview.finish("end_turn");
    expect(out.join("")).toBe(fixture.expected);
  });

  it("codex: terminal selection and live preview keep phase authority and agree", () => {
    const fixture = fixtures.find((entry) => entry.provider === "codex")!;
    const result = { updates: observed(fixture.updates), acpSessionId: "root", liveText: "ignored" } as unknown as AcpTurnResult;
    expect(selectCodexAcpAnswer(result).text).toBe(fixture.expected);
    const out: string[] = [];
    const preview = createCodexAcpAnswerPreview((text) => out.push(text), []);
    for (const update of fixture.updates) preview.observe(retained(update));
    preview.finish("end_turn");
    expect(out.join("")).toBe(fixture.expected);
  });

  it("codex: still fails closed when phase semantics exist but no final_answer does", () => {
    const only = fixtures.find((entry) => entry.provider === "codex")!.updates.filter((update) =>
      (update as { _meta?: { codex?: { phase?: string } } })._meta?.codex?.phase !== "final_answer");
    const result = { updates: observed(only), acpSessionId: "root", liveText: "commentary" } as unknown as AcpTurnResult;
    expect(selectCodexAcpAnswer(result).text).toBe("");
  });
});


describe("Grok structural interim commentary (OSS #1262)", () => {
  const say = (text: string, messageId?: string): SessionUpdate => ({
    sessionUpdate: "agent_message_chunk", content: { type: "text", text },
    ...(messageId ? { messageId } : {}),
  } as SessionUpdate);
  const tool = (): SessionUpdate => ({
    sessionUpdate: "tool_call", toolCallId: "step", title: "Run",
    status: "pending",
  } as SessionUpdate);
  const thought = (): SessionUpdate => ({
    sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "private reasoning" },
  } as SessionUpdate);
  function exercise(updates: SessionUpdate[], secrets: string[] = []) {
    const commentary: Array<{ text: string; key?: string }> = [];
    const previewText: string[] = [];
    const preview = createGrokAcpAnswerPreview((text) => previewText.push(text), secrets,
      (text, key) => commentary.push({ text, key }));
    for (const update of updates) preview.observe(retained(update));
    preview.finish("end_turn");
    const result = {
      updates: observed(updates), acpSessionId: "root",
      liveText: liveDeliveryText(observed(updates), "root"), stopReason: "end_turn",
    } as AcpTurnResult;
    return { commentary, previewText: previewText.join(""), selected: selectGrokAcpAnswer(result).text };
  }

  it("uses the recorded Grok tool boundary; retains only the later answer", () => {
    const fixture = fixtures.find((entry) => entry.provider === "grok")!;
    const { commentary, previewText, selected } = exercise(fixture.updates);
    expect(commentary).toEqual([{ key: "1", text: "Reading the file." }]);
    expect(previewText).toBe("Step two done.");
    expect(selected).toBe(previewText);
    // The standard protocol reconstruction remains unchanged for other surfaces.
    expect(liveDeliveryText(observed(fixture.updates), "root")).toBe(fixture.expected);
  });

  it("emits two independently keyed messages before a separate final answer", () => {
    const updates = [
      say("Checking files."), tool(), say("Reading README."), tool(), say("Verified final."),
    ];
    const { commentary, previewText, selected } = exercise(updates);
    expect(commentary).toEqual([
      { key: "1", text: "Checking files." },
      { key: "2", text: "Reading README." },
    ]);
    expect(previewText).toBe("Verified final.");
    expect(selected).toBe("Verified final.");
  });

  it("does not discard an answer when a tool has no subsequent message", () => {
    const updates = [say("Answer before tool."), tool()];
    const { commentary, previewText, selected } = exercise(updates);
    expect(commentary).toEqual([]);
    expect(previewText).toBe("Answer before tool.");
    expect(selected).toBe(previewText);
  });

  it("keeps a single answer and multiple messages without a tool unchanged", () => {
    for (const updates of [
      [say("Only answer.")],
      [say("First.", "a"), say("Second.", "b")],
      [say("First."), thought(), say("Second.")],
    ]) {
      const { commentary, previewText, selected } = exercise(updates);
      expect(commentary).toEqual([]);
      expect(previewText).toBe(liveDeliveryText(observed(updates), "root"));
      expect(selected).toBe(previewText);
    }
  });

  it("does not infer a tool boundary when one messageId spans the tool", () => {
    const updates = [say("The ", "a"), tool(), say("answer.", "a")];
    const { commentary, previewText, selected } = exercise(updates);
    expect(commentary).toEqual([]);
    expect(previewText).toBe("The answer.");
    expect(selected).toBe(previewText);
  });

  it("redacts a provider secret across chunk boundaries without leaking tool/thought text", () => {
    const secret = "secret-credential-123";
    const updates = [
      say("Checking secret-"), say("credential-"), say("123 now."),
      thought(), tool(), say("Completed."),
    ];
    const { commentary, selected } = exercise(updates, [secret]);
    expect(commentary).toEqual([{ key: "1", text: "Checking [REDACTED_PROVIDER_CREDENTIAL] now." }]);
    expect(JSON.stringify(commentary)).not.toContain(secret);
    expect(JSON.stringify(commentary)).not.toContain("private reasoning");
    expect(selected).toBe("Completed.");
  });

  it("ignores replay, child and presentation-suppressed events", () => {
    const commentary: string[] = [];
    const answer: string[] = [];
    const preview = createGrokAcpAnswerPreview((text) => answer.push(text), [],
      (text) => commentary.push(text));
    const discarded = say("Sensitive child/replay.");
    preview.observe({ ...retained(discarded), channel: "replay" });
    preview.observe({
      ...retained(discarded),
      notification: { sessionId: "child", update: discarded } as SessionNotification,
    });
    preview.observe({ ...retained(discarded), presentationSuppressed: true });
    for (const update of [say("Visible commentary."), tool(), say("Visible final.")]) {
      preview.observe(retained(update));
    }
    preview.finish("end_turn");
    expect(commentary).toEqual(["Visible commentary."]);
    expect(answer.join("")).toBe("Visible final.");
  });

  it("does not flush buffered final text after cancellation", () => {
    const answer: string[] = [];
    const preview = createGrokAcpAnswerPreview((text) => answer.push(text), []);
    preview.observe(retained(say("Unfinished text.")));
    preview.finish("cancelled");
    expect(answer).toEqual([]);
  });
});
