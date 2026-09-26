import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { SessionNotification, SessionUpdate } from "@agentclientprotocol/sdk";
import { createLogicalPreviewTextStream, reconstructLogicalMessages, renderLogicalMessages } from "../src/acp/logicalMessages.js";
import { liveDeliveryText, type AcpObservedUpdate } from "../src/acp/replay.js";
import type { AcpRetainedEvent } from "../src/acp/client.js";
import { createCodexAcpAnswerPreview } from "../src/providers/codexAcpAnswerPreview.js";
import { createClaudeAcpAnswerPreview } from "../src/providers/claudeAcpPolicy.js";
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
