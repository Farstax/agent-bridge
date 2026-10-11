import { describe, expect, it, vi } from "vitest";
import { CANDIDATE_PARSERS } from "../src/markdown/index.js";
import { sendTelegramMessage } from "../src/messageDelivery.js";
import { TELEGRAM_SURFACE_CAPABILITIES } from "../src/platform.js";
import {
  renderDiscord,
  renderTelegramHtml,
  renderTelegramRichHtml,
} from "../src/markdown/renderers.js";
import { MARKDOWN_SPIKE_FIXTURES } from "./fixtures/markdownSpikeFixtures.js";

/**
 * Surface-delivery harness for the spike. It owns no transport policy: it
 * captures the exact payload a Telegram HTML transport would receive after a
 * candidate parser and the shared Telegram renderer have run.
 */
async function deliverTelegramHtml(
  sendMessage: (body: { chat_id: number; text: string; parse_mode: "HTML" }) => Promise<unknown>,
  markdown: string,
  parserId: keyof typeof CANDIDATE_PARSERS,
): Promise<void> {
  const parser = CANDIDATE_PARSERS[parserId];
  await sendMessage({
    chat_id: 123,
    text: renderTelegramHtml(parser.parse(markdown)),
    parse_mode: "HTML",
  });
}

describe("markdown parser spike surface payloads", () => {
  const looseList = MARKDOWN_SPIKE_FIXTURES.find((fixture) => fixture.id === "cat1-consecutive-blank-lines")!;
  const security = MARKDOWN_SPIKE_FIXTURES.find((fixture) => fixture.id === "cat9-security-html-links-unicode")!;
  const table = MARKDOWN_SPIKE_FIXTURES.find((fixture) => fixture.id === "cat6-table-with-formatting")!;

  for (const parserId of ["marked", "markdown-it", "remark"] as const) {
    it(`${parserId} sends one Telegram HTML payload with continuous loose-list numbering`, async () => {
      const sendMessage = vi.fn(async () => ({ ok: true }));

      await deliverTelegramHtml(sendMessage, looseList.input, parserId);

      expect(sendMessage).toHaveBeenCalledOnce();
      expect(sendMessage).toHaveBeenCalledWith({
        chat_id: 123,
        parse_mode: "HTML",
        text: expect.stringContaining("1. First task\n2. Second task\n3. Third task"),
      });
    });

    it(`${parserId} escapes raw HTML and renders unsafe links as text in the Telegram payload`, () => {
      const html = renderTelegramHtml(CANDIDATE_PARSERS[parserId].parse(security.input));

      expect(html).toContain("&lt;script&gt;");
      expect(html).not.toContain("<script>");
      expect(html).not.toContain('href="javascript:');
      expect(html).toContain("javascript:stealTokens()");
    });

    it(`${parserId} produces readable Telegram rich-table and Discord payloads`, () => {
      const ir = CANDIDATE_PARSERS[parserId].parse(table.input);
      const richHtml = renderTelegramRichHtml(ir);
      const discord = renderDiscord(ir);

      expect(richHtml).toContain("<table bordered striped>");
      expect(richHtml).toContain("<th>Service</th>");
      expect(discord).toContain("**Service**");
      expect(discord).toContain("Bridge");
    });
  }

  it("keeps the current custom parser as a failing baseline for loose ordered lists", async () => {
    const sendMessage = vi.fn(async () => ({ ok: true }));

    await deliverTelegramHtml(sendMessage, looseList.input, "custom");

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("1. First task\n1. Second task\n1. Third task"),
    }));
  });

  it("reproduces list-number loss in the current production Telegram path after raw-text chunking", async () => {
    const client = {
      capabilities: TELEGRAM_SURFACE_CAPABILITIES,
      sendMessage: vi.fn(async (body: unknown) => ({ ok: true, result: { message_id: 1, body } })),
    };
    const input = Array.from({ length: 20 }, (_, index) => `${index + 1}. ${"item ".repeat(55)}${index + 1}`).join("\n");

    await sendTelegramMessage({ client, kind: "telegram", chatId: 123, body: { text: input } });

    const payloads = client.sendMessage.mock.calls.map(([body]) => body as { text: string });
    expect(payloads.length).toBeGreaterThan(1);
    expect(payloads[1]!.text).toMatch(/^1\. /);
  });

  it("reproduces Telegram HTML expansion beyond the API message limit in the current production path", async () => {
    const client = {
      capabilities: TELEGRAM_SURFACE_CAPABILITIES,
      sendMessage: vi.fn(async (body: unknown) => ({ ok: true, result: { message_id: 1, body } })),
    };

    await sendTelegramMessage({ client, kind: "telegram", chatId: 123, body: { text: "<".repeat(3_500) } });

    const payload = client.sendMessage.mock.calls[0]![0] as { text: string };
    expect(payload.text.length).toBeGreaterThan(4_096);
  });
});
