import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chunkText } from "../src/discord.js";
import { DiscordClient } from "../src/discord.js";

// Phase 5 red: verify that answerCallbackQuery passes through a full `data` payload
// (needed for UPDATE_MESSAGE / channel-message-with-source interaction responses with components).

describe("DiscordClient.answerCallbackQuery with data field", () => {
  function makeClient(fetchMock: any) {
    return new DiscordClient(
      { token: "tok", applicationId: "app", onUpdate: vi.fn() },
      fetchMock,
    );
  }

  it("sends the data field verbatim when provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204, json: async () => null });
    const client = makeClient(fetchMock);

    await client.answerCallbackQuery({
      interaction_id: "i-1",
      interaction_token: "t-1",
      type: 7,
      data: {
        content: "Active CLI: claude",
        components: [{ type: 1, components: [{ type: 2, label: "codex", custom_id: "cli:codex" }] }],
      },
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.type).toBe(7);
    expect(body.data.content).toBe("Active CLI: claude");
    expect(body.data.components).toHaveLength(1);
  });

  it("falls back to text-only content when data is absent", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204, json: async () => null });
    const client = makeClient(fetchMock);

    await client.answerCallbackQuery({
      interaction_id: "i-2",
      interaction_token: "t-2",
      type: 4,
      text: "hello",
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.type).toBe(4);
    expect(body.data.content).toBe("hello");
  });
});

describe("Discord run continuation wiring", () => {
  it("starts and stops the continuation runner with the gateway runtime", () => {
    const source = readFileSync(join(process.cwd(), "src", "index-discord-interactive.ts"), "utf8");
    expect(source).toContain("new RunContinuationRunner(");
    expect(source).toContain("runContinuationRunner?.start()");
    expect(source).toContain("runContinuationRunner?.stop()");
    expect(source).toContain("buildDiscordRunContinuationTurn");
  });
});

