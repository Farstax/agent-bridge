import { afterEach, describe, expect, it, vi } from "vitest";
import { chunkText, DiscordClient, MAX_DISCORD_MESSAGE_LENGTH } from "../src/discord.js";

const LIMIT = MAX_DISCORD_MESSAGE_LENGTH;

function numberedList(count: number): string {
  return Array.from({ length: count }, (_, i) =>
    `${i + 1}. Item ${i + 1} ${"word ".repeat(30).trim()}`).join("\n\n");
}

function fenceBalanced(chunk: string): boolean {
  return (chunk.match(/^\s*```/gm) ?? []).length % 2 === 0;
}

describe("Discord structure-aware chunking", () => {
  it("splits a 120-item list on item boundaries without losing or duplicating items", () => {
    const chunks = chunkText(numberedList(120));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= LIMIT)).toBe(true);
    const numbers = chunks.flatMap((c) => [...c.matchAll(/^(\d+)\. Item/gm)].map((m) => Number(m[1])));
    expect(numbers).toEqual(Array.from({ length: 120 }, (_, i) => i + 1));
    // No item is cut mid-way: every chunk starts at an item.
    for (const chunk of chunks) expect(chunk).toMatch(/^\d+\. Item/);
  });

  it("closes and reopens a fenced block that crosses a chunk boundary", () => {
    const code = Array.from({ length: 200 }, (_, i) => `line ${i} **not bold**`).join("\n");
    const chunks = chunkText(`intro\n\n\`\`\`ts\n${code}\n\`\`\`\n\noutro`);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(LIMIT);
      expect(fenceBalanced(chunk)).toBe(true);
    }
    expect(chunks[1].startsWith("```ts\n")).toBe(true);
    const lines = chunks.join("\n").split("\n").filter((l) => l.startsWith("line "));
    expect(lines).toHaveLength(200);
  });

  it("does not split a surrogate pair", () => {
    const chunks = chunkText("😀".repeat(LIMIT));
    for (const chunk of chunks) expect(chunk).not.toMatch(/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/);
    expect(chunks.join("")).toBe("😀".repeat(LIMIT));
  });

  it("keeps an oversized single line within the limit", () => {
    const chunks = chunkText("x".repeat(LIMIT * 2 + 5));
    expect(chunks.every((c) => c.length <= LIMIT)).toBe(true);
    expect(chunks.join("")).toBe("x".repeat(LIMIT * 2 + 5));
  });
});

describe("DiscordClient.sendMessage with the Markdown IR enabled", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function deliver(text: string): Promise<string[]> {
    vi.stubEnv("DISCORD_MARKDOWN_IR_ENABLED", "true");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: "1" }),
      text: async () => "{}",
      headers: new Headers(),
    });
    const client = new DiscordClient({ token: "t", applicationId: "a", onUpdate: vi.fn() }, fetchMock as never);
    await client.sendMessage({ channel_id: "c", text });
    return fetchMock.mock.calls.map(([, init]) => JSON.parse((init as { body: string }).body).content as string);
  }

  it("keeps nested bullet and ordered lists indented", async () => {
    const [content] = await deliver("Nested list:\n\n- Evidence\n  - logs\n  - state\n- Recovery\n  1. first\n  2. second\n");
    expect(content).toContain("- Evidence\n  - logs\n  - state\n- Recovery\n  1. first\n  2. second");
  });

  it("delivers the five-step list and a 120-item list in order, once", async () => {
    const [short] = await deliver("1. a\n\n1. b\n\n1. c\n\n4. d\n\n5. e");
    expect(short).toBe("1. a\n2. b\n3. c\n4. d\n5. e");
    const contents = await deliver(numberedList(120));
    expect(contents.every((c) => c.length <= LIMIT)).toBe(true);
    const numbers = contents.flatMap((c) => [...c.matchAll(/^(\d+)\. Item/gm)].map((m) => Number(m[1])));
    expect(numbers).toEqual(Array.from({ length: 120 }, (_, i) => i + 1));
  });

  it("keeps code fences balanced across chunks and preserves Markdown-like text", async () => {
    const code = Array.from({ length: 250 }, (_, i) => `row ${i} **literal**`).join("\n");
    const contents = await deliver(`Plan\n\n\`\`\`\n${code}\n\`\`\`\n`);
    expect(contents.length).toBeGreaterThan(1);
    for (const c of contents) expect(fenceBalanced(c)).toBe(true);
    expect(contents.join("\n").match(/row \d+ \*\*literal\*\*/g)).toHaveLength(250);
  });
});
