import { describe, it, expect } from "vitest";
import {
  parseMarkdownToIR,
  markdownToTelegramHtmlChunks,
  renderMarkerString,
  DISCORD_MARKERS,
  TELEGRAM_HTML_MARKERS,
  TELEGRAM_RICH_HTML_MARKERS,
  discordMarkdownIrEnabled,
} from "../src/markdownIR.js";

describe("parseMarkdownToIR", () => {
  it("parses plain text with no markup", () => {
    expect(parseMarkdownToIR("hello world")).toEqual([
      { type: "text", value: "hello world" },
    ]);
  });

  it("parses a bold span", () => {
    expect(parseMarkdownToIR("**Done**")).toEqual([
      { type: "bold", value: "Done" },
    ]);
  });

  it("parses text surrounding a bold span", () => {
    expect(parseMarkdownToIR("✅ **Done** — shipped")).toEqual([
      { type: "text", value: "✅ " },
      { type: "bold", value: "Done" },
      { type: "text", value: " — shipped" },
    ]);
  });

  it("parses an inline code span", () => {
    expect(parseMarkdownToIR("run `npm test` now")).toEqual([
      { type: "text", value: "run " },
      { type: "code_inline", value: "npm test" },
      { type: "text", value: " now" },
    ]);
  });

  it("preserves italic and strikethrough as typed inline nodes", () => {
    expect(parseMarkdownToIR("*emphasis* and ~~removed~~")).toEqual([
      { type: "italic", value: "emphasis" },
      { type: "text", value: " and " },
      { type: "strikethrough", value: "removed" },
    ]);
    expect(renderMarkerString(parseMarkdownToIR("*emphasis* and ~~removed~~"), TELEGRAM_HTML_MARKERS)).toBe(
      "<i>emphasis</i> and <s>removed</s>",
    );
  });

  it("keeps nested inline formatting inside structured list items", () => {
    const document = parseMarkdownToIR("- **bold `code` and *italic***");
    expect(renderMarkerString(document, TELEGRAM_HTML_MARKERS)).toBe(
      "• <b>bold <code>code</code> and <i>italic</i></b>",
    );
  });

  it("keeps paragraphs and nested lists inside a list item on separate lines", () => {
    const document = parseMarkdownToIR("1. a\n   - x\n   - y\n2. b\n\n   para in b");
    expect(renderMarkerString(document, TELEGRAM_HTML_MARKERS, "\n\n")).toBe("1. a\n• x\n• y\n2. b\npara in b");
    expect(renderMarkerString(document, TELEGRAM_RICH_HTML_MARKERS, "<br><br>")).toBe("1. a<br>• x<br>• y<br>2. b<br>para in b");
    expect(renderMarkerString(document, DISCORD_MARKERS)).toBe("1. a\n   - x\n   - y\n2. b\n   para in b");
  });

  it("keeps paragraph, hard-break, quote and rule spacing on every surface", () => {
    const document = parseMarkdownToIR("one\n\ntwo  \nbreak\n\n## Head\n\n> quote **q**\n> more\n\n---\n\nend");
    expect(renderMarkerString(document, TELEGRAM_HTML_MARKERS, "\n\n")).toBe(
      "one\n\ntwo\nbreak\n\n<b>Head</b>\n\n&gt; quote <b>q</b>\n&gt; more\n\n---\n\nend",
    );
    expect(renderMarkerString(document, TELEGRAM_RICH_HTML_MARKERS, "<br><br>")).toBe(
      "one<br><br>two<br>break<br><br><b>Head</b><br><br>&gt; quote <b>q</b><br>&gt; more<br><br>---<br><br>end",
    );
    expect(renderMarkerString(document, DISCORD_MARKERS)).toBe("one\n\ntwo\nbreak\n## Head\n> quote **q**\n> more\n\n---\n\nend");
  });

  it("keeps task markers and image targets", () => {
    const document = parseMarkdownToIR("- [ ] todo\n- [x] done\n\n![alt](https://example.test/a.png)");
    expect(renderMarkerString(document, TELEGRAM_HTML_MARKERS, "\n\n")).toBe(
      '• [ ] todo\n• [x] done\n\n<a href="https://example.test/a.png">alt</a>',
    );
  });

  it("treats an unmatched ** as plain text", () => {
    expect(parseMarkdownToIR("a ** b")).toEqual([
      { type: "text", value: "a ** b" },
    ]);
  });

  it("joins multiple plain lines into one paragraph with embedded newlines", () => {
    expect(parseMarkdownToIR("line one\nline two")).toEqual([
      { type: "text", value: "line one\nline two" },
    ]);
  });

  it("returns an empty array for empty input", () => {
    expect(parseMarkdownToIR("")).toEqual([]);
  });

  it("parses a code block with a language tag", () => {
    expect(parseMarkdownToIR("```js\nconsole.log(1);\n```")).toEqual([
      { type: "code_block", value: "console.log(1);", language: "js" },
    ]);
  });

  it("parses a code block with no language tag", () => {
    expect(parseMarkdownToIR("```\nplain content\n```")).toEqual([
      { type: "code_block", value: "plain content", language: undefined },
    ]);
  });

  it("preserves angle brackets and ampersands inside a code block untouched", () => {
    expect(parseMarkdownToIR('```js\nif (x < 1 && y > 2) { log("<b>hi</b>"); }\n```')).toEqual([
      { type: "code_block", value: 'if (x < 1 && y > 2) { log("<b>hi</b>"); }', language: "js" },
    ]);
  });

  it("treats text before and after a code block as separate paragraphs", () => {
    expect(parseMarkdownToIR("before\n```\ncode\n```\nafter")).toEqual([
      { type: "text", value: "before" },
      { type: "code_block", value: "code", language: undefined },
      { type: "text", value: "after" },
    ]);
  });

  it("parses a level-1 heading", () => {
    expect(parseMarkdownToIR("# Title")).toEqual([
      { type: "heading", level: 1, value: "Title" },
    ]);
  });

  it("parses a level-3 heading", () => {
    expect(parseMarkdownToIR("### Sub Title")).toEqual([
      { type: "heading", level: 3, value: "Sub Title" },
    ]);
  });

  it("treats a heading and following paragraph as separate nodes", () => {
    expect(parseMarkdownToIR("## Section\nbody text")).toEqual([
      { type: "heading", level: 2, value: "Section" },
      { type: "text", value: "body text" },
    ]);
  });

  it("parses a markdown table", () => {
    const markdown = "| Name | Age |\n| --- | --- |\n| Alice | 30 |\n| Bob | 25 |";
    expect(parseMarkdownToIR(markdown)).toMatchObject([
      {
        type: "table",
        headers: ["Name", "Age"],
        rows: [["Alice", "30"], ["Bob", "25"]],
      },
    ]);
  });

  it("does not treat a lone pipe-containing line without a separator as a table", () => {
    expect(parseMarkdownToIR("a | b")).toEqual([
      { type: "text", value: "a | b" },
    ]);
  });

  it("treats text before and after a table as separate paragraphs", () => {
    const markdown = "summary:\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nend.";
    expect(parseMarkdownToIR(markdown)).toMatchObject([
      { type: "text", value: "summary:" },
      { type: "table", headers: ["A", "B"], rows: [["1", "2"]] },
      { type: "text", value: "end." },
    ]);
  });

  it("parses a bullet list using -", () => {
    expect(parseMarkdownToIR("- first\n- second")[0]).toMatchObject({
      type: "list", ordered: false, items: ["first", "second"], children: [[{ type: "text", value: "first" }], [{ type: "text", value: "second" }]],
    });
  });

  it("parses a bullet list using *", () => {
    expect(parseMarkdownToIR("* first\n* second")[0]).toMatchObject({ type: "list", ordered: false, items: ["first", "second"] });
  });

  it("treats text before and after a list as separate paragraphs", () => {
    expect(parseMarkdownToIR("intro\n- one\n- two\n\noutro")).toMatchObject([
      { type: "text", value: "intro" },
      { type: "list", items: ["one", "two"] },
      { type: "text", value: "outro" },
    ]);
  });

  it("preserves a blank line between text and a following block as paragraph separation", () => {
    expect(parseMarkdownToIR("intro\n\n- one\n- two")).toMatchObject([
      { type: "text", value: "intro" },
      { type: "list", items: ["one", "two"] },
    ]);
  });

  it("parses a numbered (ordered) list", () => {
    expect(parseMarkdownToIR("1. first\n2. second\n3. third")[0]).toMatchObject({ type: "list", ordered: true, start: 1, items: ["first", "second", "third"] });
  });

  it("parses a numbered list with non-1 starting number", () => {
    expect(parseMarkdownToIR("3. alpha\n4. beta")[0]).toMatchObject({ type: "list", ordered: true, start: 3, items: ["alpha", "beta"] });
  });

  it("keeps blank-line-separated model list items in one numbered sequence", () => {
    const document = parseMarkdownToIR("1. first\n\n1. second\n\n1. third");
    expect(document).toMatchObject([{ type: "list", ordered: true, start: 1, items: ["first", "second", "third"] }]);
    expect(renderMarkerString(document, TELEGRAM_HTML_MARKERS)).toBe("1. first\n2. second\n3. third");
  });

  it("treats text before and after an ordered list as separate paragraphs", () => {
    expect(parseMarkdownToIR("intro\n1. one\n2. two\n\noutro")).toMatchObject([
      { type: "text", value: "intro" },
      { type: "list", ordered: true, start: 1, items: ["one", "two"] },
      { type: "text", value: "outro" },
    ]);
  });
});

describe("renderMarkerString with DISCORD_MARKERS", () => {
  it("renders bold, code, and plain text", () => {
    const ir = parseMarkdownToIR("✅ **Done** — `npm test` passed");
    expect(renderMarkerString(ir, DISCORD_MARKERS)).toBe("✅ **Done** — `npm test` passed");
  });

  it("renders a code block with language fence", () => {
    const ir = parseMarkdownToIR("```js\nconsole.log(1);\n```");
    expect(renderMarkerString(ir, DISCORD_MARKERS)).toBe("```js\nconsole.log(1);\n```");
  });

  it("renders a heading using a # prefix", () => {
    const ir = parseMarkdownToIR("## Section");
    expect(renderMarkerString(ir, DISCORD_MARKERS)).toBe("## Section");
  });

  it("renders a list using - bullets", () => {
    const ir = parseMarkdownToIR("- one\n- two");
    expect(renderMarkerString(ir, DISCORD_MARKERS)).toBe("- one\n- two");
  });

  it("renders an ordered list using numbered format", () => {
    const ir = parseMarkdownToIR("1. first\n2. second");
    expect(renderMarkerString(ir, DISCORD_MARKERS)).toBe("1. first\n2. second");
  });

  it("renders text immediately before a list with a line break", () => {
    const ir = parseMarkdownToIR("Here are the options:\n- one\n- two");
    expect(renderMarkerString(ir, DISCORD_MARKERS)).toBe("Here are the options:\n- one\n- two");
  });

  it("renders text immediately before a list with text following", () => {
    const ir = parseMarkdownToIR("intro:\n- one\n- two\n\noutro");
    expect(renderMarkerString(ir, DISCORD_MARKERS)).toBe("intro:\n- one\n- two\noutro");
  });

  it("renders a table as a bold-label card list", () => {
    const ir = parseMarkdownToIR("| Name | Age |\n| --- | --- |\n| Alice | 30 |");
    expect(renderMarkerString(ir, DISCORD_MARKERS)).toBe("**Name:** Alice\n- **Age:** 30");
  });
});

describe("renderMarkerString with TELEGRAM_HTML_MARKERS", () => {
  it("renders bold and inline code inside unordered list items", () => {
    const ir = parseMarkdownToIR("- **Codex:** run `npm test`\n- **Agy:** restarted");
    expect(renderMarkerString(ir, TELEGRAM_HTML_MARKERS)).toBe(
      "• <b>Codex:</b> run <code>npm test</code>\n• <b>Agy:</b> restarted",
    );
  });

  it("renders bold and inline code inside ordered list items", () => {
    const ir = parseMarkdownToIR("1. **First:** check `logs`\n2. **Second:** restart");
    expect(renderMarkerString(ir, TELEGRAM_HTML_MARKERS)).toBe(
      "1. <b>First:</b> check <code>logs</code>\n2. <b>Second:</b> restart",
    );
  });

  it("renders inline spans inside table cells", () => {
    const ir = parseMarkdownToIR("| Bot | Status |\n| --- | --- |\n| **Codex** | `trusted` |");
    expect(renderMarkerString(ir, TELEGRAM_HTML_MARKERS)).toBe(
      "<b>Bot</b> <b>Codex</b>\n• <b>Status</b> <code>trusted</code>",
    );
  });

  it("separates a heading from following body text with a blank line", () => {
    const ir = parseMarkdownToIR("## Summary\nBody text here");
    expect(renderMarkerString(ir, TELEGRAM_HTML_MARKERS, "\n\n")).toBe(
      "<b>Summary</b>\n\nBody text here",
    );
  });

  it("separates a list from following text with a blank line", () => {
    const ir = parseMarkdownToIR("intro:\n- one\n- two\n\noutro");
    expect(renderMarkerString(ir, TELEGRAM_HTML_MARKERS, "\n\n")).toBe(
      "intro:\n• one\n• two\n\noutro",
    );
  });

  it("separates a code block from following text with a blank line", () => {
    const ir = parseMarkdownToIR("before\n```\ncode\n```\nafter");
    expect(renderMarkerString(ir, TELEGRAM_HTML_MARKERS, "\n\n")).toBe(
      "before\n<pre>code</pre>\n\nafter",
    );
  });
});

describe("feature flags", () => {
  it("discordMarkdownIrEnabled defaults to false", () => {
    delete process.env.DISCORD_MARKDOWN_IR_ENABLED;
    expect(discordMarkdownIrEnabled()).toBe(false);
  });

  it("discordMarkdownIrEnabled is true when env var is 'true'", () => {
    process.env.DISCORD_MARKDOWN_IR_ENABLED = "true";
    expect(discordMarkdownIrEnabled()).toBe(true);
    delete process.env.DISCORD_MARKDOWN_IR_ENABLED;
  });
});

describe("markdownToTelegramHtmlChunks", () => {
  const visibleLength = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&(?:amp|lt|gt|quot);/g, "x").length;
  const balanced = (html: string) => {
    for (const tag of ["b", "i", "s", "code", "pre", "a"]) {
      expect(html.match(new RegExp(`<${tag}[ >]`, "g"))?.length ?? 0).toBe(html.match(new RegExp(`</${tag}>`, "g"))?.length ?? 0);
    }
  };

  it.each([
    ["table rows", "| Case | Detail | Result |\n|---|---|---|\n" + Array.from({ length: 80 }, (_, i) => `| C${i} | ${"detail <x> & ".repeat(8)} | **PASS** |`).join("\n")],
    ["one oversized table row", `| A | B |\n|---|---|\n| ${"x".repeat(9000)} | y |`],
    ["paragraphs", Array.from({ length: 30 }, (_, i) => `Sentence ${i} with **bold** and \`code\` ${"word ".repeat(40)}`).join("\n\n")],
    ["surrogate pairs", "😀".repeat(5000)],
    ["escaped code", "```ts\n" + "const x = '<&>';\n".repeat(600) + "```"],
    ["one oversized list item", `7. **${"w ".repeat(3000)}**\n8. next`],
    ["one oversized bold span", `**${"b".repeat(9000)}**`],
  ])("keeps every chunk of %s valid and within the post-entity limit", (_name, markdown) => {
    const chunks = markdownToTelegramHtmlChunks(markdown);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(visibleLength(chunk)).toBeGreaterThan(0);
      expect(visibleLength(chunk)).toBeLessThanOrEqual(4096);
      expect(chunk).not.toMatch(/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/);
      balanced(chunk);
    }
  });

  it("splits a table between rows and repeats the card labels", () => {
    const markdown = "| Case | Result |\n|---|---|\n" + Array.from({ length: 300 }, (_, i) => `| C${i} | ok ${"y".repeat(30)} |`).join("\n");
    const chunks = markdownToTelegramHtmlChunks(markdown);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk).toMatch(/^<b>Case<\/b> C\d+\n• <b>Result<\/b> ok y+/);
    expect(chunks.join("\n").match(/<b>Case<\/b>/g)).toHaveLength(300);
  });

  it("splits code on line boundaries and keeps the language", () => {
    const chunks = markdownToTelegramHtmlChunks("```ts\n" + "const x = 1;\n".repeat(700) + "```");
    for (const chunk of chunks) expect(chunk).toMatch(/^<pre language="ts">const x = 1;[\s\S]*const x = 1;\n?<\/pre>$/);
  });

  it("does not drop or repeat text when paragraphs cross a chunk boundary", () => {
    const paragraphs = Array.from({ length: 40 }, (_, i) => `P${i} ${"word ".repeat(60).trim()}`);
    const chunks = markdownToTelegramHtmlChunks(paragraphs.join("\n\n"));
    expect(chunks.join("\n\n")).toBe(paragraphs.join("\n\n"));
  });
});
