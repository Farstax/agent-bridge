import { describe, expect, it } from "vitest";
import { escapeTelegramMarkdownV2, renderTelegramEntitiesFromIR, splitTelegramText, toTelegramEntitiesText } from "../src/render.js";
import { parseMarkdownToIR } from "../src/markdownIR.js";

describe("escapeTelegramMarkdownV2", () => {
  it("escapes reserved characters in plain text", () => {
    expect(escapeTelegramMarkdownV2("Hello-world.!")).toBe("Hello\\-world\\.\\!");
  });

  it("does not escape the delimiter backticks of inline code", () => {
    expect(escapeTelegramMarkdownV2("`v1.0.0-beta`")).toBe("`v1.0.0-beta`");
    expect(escapeTelegramMarkdownV2("Fixed: `v1.0.0-beta`")).toBe("Fixed: `v1.0.0-beta`");
  });

  it("does not escape triple-backtick fences", () => {
    expect(escapeTelegramMarkdownV2("```\nconst x = 1-2;\n```")).toBe("```\nconst x = 1-2;\n```");
  });

  it("preserves bold and italic syntax while escaping content", () => {
    expect(escapeTelegramMarkdownV2("*bold text*")).toBe("*bold text*");
  });

  it("escapes orphaned markers that would cause Telegram parsing errors", () => {
    expect(escapeTelegramMarkdownV2("This is *orphaned")).toBe("This is \\*orphaned");
    expect(escapeTelegramMarkdownV2("*bold* and *balanced*")).toBe("*bold* and *balanced*");
    expect(escapeTelegramMarkdownV2("*bold* and _italic and *bold")).toBe("*bold* and \\_italic and \\*bold");
  });
});

describe("splitTelegramText", () => {
  it("preserves short and empty messages", () => {
    expect(splitTelegramText("Short message")).toEqual(["Short message"]);
    expect(splitTelegramText("")).toEqual([""]);
  });

  it("splits long messages within the Telegram limit without losing content", () => {
    const text = ("word ".repeat(900)).trimEnd();
    const chunks = splitTelegramText(text);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 3500)).toBe(true);
    expect(chunks.join(" ").replace(/\s+/g, " ").trim()).toBe(text.replace(/\s+/g, " ").trim());
  });

  it("prefers paragraph boundaries when splitting", () => {
    const text = "Line of text.\n\n".repeat(300);
    const chunks = splitTelegramText(text);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.trimEnd().endsWith("Line of text."))).toBe(true);
  });
});

describe("toTelegramEntitiesText", () => {
  it("uses Telegram pre language metadata instead of showing the fence language", () => {
    const result = toTelegramEntitiesText("```ts\nconst x = 1;\n```");
    expect(result.text).toBe("const x = 1;\n");
    expect(result.entities).toEqual([{ type: "pre", offset: 0, length: 13, language: "ts" }]);
  });

  it("renders unlabeled fenced code blocks without language metadata", () => {
    const result = toTelegramEntitiesText("```\nconst x = 1;\n```");
    expect(result.text).toBe("const x = 1;\n");
    expect(result.entities).toEqual([{ type: "pre", offset: 0, length: 13 }]);
  });

  it.each([
    ["# Title", "Title"],
    ["## Section", "Section"],
    ["### Hello World", "Hello World"],
  ])("renders %s as bold heading text", (input, expectedText) => {
    const result = toTelegramEntitiesText(input);
    expect(result.text).toContain(expectedText);
    expect(result.entities).toContainEqual({ type: "bold", offset: 0, length: expectedText.length });
  });
});

describe("renderTelegramEntitiesFromIR", () => {
  const cases = [
    "Use a List<String> type here, not <Object>.",
    "Fetch & retry on 5xx, **respect** Retry-After.",
    "**a < b && c > d**",
    "✅ **Done** — 🚀 shipped to prod 🎉",
    "run `npm test` now",
    "### Section\nbody text",
    "plain text with no markup at all",
  ];

  it.each(cases)("matches toTelegramEntitiesText output for: %s", (input) => {
    const legacy = toTelegramEntitiesText(input);
    const ir = parseMarkdownToIR(input.replace(/^(#{1,3})\s+(.+)$/m, "$1 $2"));
    const next = renderTelegramEntitiesFromIR(ir);
    expect(next).toEqual(legacy);
  });

  it("renders a code block as a pre entity with language", () => {
    const ir = parseMarkdownToIR("```js\nconsole.log(1);\n```");
    expect(renderTelegramEntitiesFromIR(ir)).toEqual({
      text: "console.log(1);\n",
      entities: [{ type: "pre", offset: 0, length: 16, language: "js" }],
    });
  });

  it("returns empty text and entities for empty input", () => {
    expect(renderTelegramEntitiesFromIR([])).toEqual({ text: "", entities: [] });
  });

  it("renders an ordered list as numbered plain text", () => {
    const ir = parseMarkdownToIR("1. first\n2. second");
    expect(renderTelegramEntitiesFromIR(ir)).toEqual({
      text: "1. first\n2. second",
      entities: [],
    });
  });

  it("renders text immediately before a list with a separating newline", () => {
    const ir = parseMarkdownToIR("Options:\n1. A\n2. B");
    expect(renderTelegramEntitiesFromIR(ir)).toEqual({
      text: "Options:\n1. A\n2. B",
      entities: [],
    });
  });

  it("renders text before and after a list with newline separators", () => {
    const ir = parseMarkdownToIR("intro:\n- one\n- two\noutro");
    expect(renderTelegramEntitiesFromIR(ir)).toEqual({
      text: "intro:\n- one\n- two\noutro",
      entities: [],
    });
  });

  it("renders bold inside an unordered list item as a bold entity", () => {
    const ir = parseMarkdownToIR("- **bold** item\n- plain item");
    const result = renderTelegramEntitiesFromIR(ir);
    expect(result.text).toBe("- bold item\n- plain item");
    expect(result.entities).toEqual([{ type: "bold", offset: 2, length: 4 }]);
  });

  it("renders inline code inside a list item as a code entity", () => {
    const ir = parseMarkdownToIR("- run `npm test` now");
    const result = renderTelegramEntitiesFromIR(ir);
    expect(result.text).toBe("- run npm test now");
    expect(result.entities).toEqual([{ type: "code", offset: 6, length: 8 }]);
  });

  it("renders inline spans in ordered list items with correct offsets", () => {
    const ir = parseMarkdownToIR("1. **first** item\n2. second `code`");
    const result = renderTelegramEntitiesFromIR(ir);
    expect(result.text).toBe("1. first item\n2. second code");
    expect(result.entities).toEqual([
      { type: "bold", offset: 3, length: 5 },
      { type: "code", offset: 24, length: 4 },
    ]);
  });

  it("renders a table as a card list with bold header entities", () => {
    const ir = parseMarkdownToIR("| Name | Age |\n| --- | --- |\n| Alice | 30 |\n| Bob | 25 |");
    const result = renderTelegramEntitiesFromIR(ir);
    expect(result.text).toBe("Name: Alice\nAge: 30\n---\nName: Bob\nAge: 25");
    expect(result.entities).toEqual([
      { type: "bold", offset: 0, length: 4 },
      { type: "bold", offset: 12, length: 3 },
      { type: "bold", offset: 24, length: 4 },
      { type: "bold", offset: 34, length: 3 },
    ]);
  });
});
