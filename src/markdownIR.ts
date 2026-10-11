import { marked, type Token, type Tokens } from "marked";

/**
 * markdownIR.ts — Intermediate Representation (IR) pipeline for markdown rendering.
 *
 * ## Architecture overview
 *
 * Markdown from CLI output goes through a two-stage pipeline before reaching Telegram:
 *
 *   1. PARSE  — parseMarkdownToIR() converts raw markdown text into a typed IRNode[]
 *               tree. Block nodes (headings, tables, lists, code blocks) are detected
 *               with Marked and converted into a surface-neutral representation.
 *
 *   2. RENDER — renderMarkerString() walks the IRNode[] and applies a MarkerTable,
 *               which is a set of functions that map each node type to its target
 *               format string. Swapping the MarkerTable changes the output format
 *               (Telegram HTML, Discord Markdown, etc.) without touching the parser.
 *
 * ## Two Telegram rendering paths
 *
 * Telegram has two distinct HTML modes that handle whitespace differently:
 *
 *   Path A — parse_mode: "HTML"  (sendEntityMessages)
 *     Used for all non-table messages. Telegram's own HTML parser preserves literal
 *     \n characters as line breaks. MarkerTable: TELEGRAM_HTML_MARKERS.
 *     Block separator: "\n\n".
 *
 *   Path B — rich_message: { html: "..." }  (sendRichMessage, Bot API 10.1+)
 *     Used when the message contains a markdown table. The payload is rendered as a
 *     real HTML document, so \n is treated as whitespace and COLLAPSED by the HTML
 *     parser — exactly like a browser. All line breaks MUST be <br> tags, and the
 *     block separator must also be "<br><br>".
 *     MarkerTable: TELEGRAM_RICH_HTML_MARKERS. Block separator: "<br><br>".
 *     Falls back to Path A (card-style) if sendRichMessage is unavailable.
 *
 * ## Routing (messageDelivery.ts → routeNativeLayout)
 *
 *   table detected → kind:"html" → try sendRichMessage (Path B) → fallback sendEntityMessages (Path A)
 *   no table       → kind:"text" → sendEntityMessages (Path A)
 *   very long text → kind:"document" → sendDocumentBuffer (file attachment)
 *
 * ## Inline rendering inside list items
 *
 * List item content is itself markdown and needs inline span parsing. renderInlineMarkerText()
 * recursively parses item strings and renders them using a reduced marker set (text, bold,
 * code_inline, link). It accepts a lineSep parameter so that Path B can use "<br>" while
 * Path A uses "\n". renderTelegramInlineHtml() is the concrete closure for Path B.
 *
 * ## Known limitations (Telegram HTML does not support these tags)
 *   - Headings rendered as <b> only (no <h1>/<h2>)
 *   - Italic (*text*) not parsed — shows as raw *text*
 *   - Strikethrough (~~text~~) not parsed — shows as raw ~~text~~
 *   - Horizontal rule (---) falls through to paragraph text
 */

// ── IR node types ─────────────────────────────────────────────────────────────

/** All possible nodes produced by parseMarkdownToIR. */
export type IRNode =
  | { type: "text"; value: string }
  | { type: "bold"; value: string }
  | { type: "code_inline"; value: string }
  | { type: "code_block"; value: string; language?: string }
  | { type: "heading"; level: number; value: string }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "list"; items: string[]; ordered?: boolean; start?: number }
  | { type: "link"; text: string; url: string };

// ── Block parser ──────────────────────────────────────────────────────────────

/** The single production parser boundary. */
export function parseMarkdownToIR(markdown: string): IRNode[] {
  return marked.lexer(markdown).flatMap(markedTokenToIr);
}

function markedTokenToIr(token: Token): IRNode[] {
  switch (token.type) {
    case "heading": return [{ type: "heading", level: token.depth, value: token.text }];
    case "code": return [{ type: "code_block", value: token.text, language: token.lang?.split(/\s+/, 1)[0] }];
    case "paragraph": return inlineTokensToIr(token.tokens) || [{ type: "text", value: token.text }];
    case "html": return [{ type: "text", value: token.raw }];
    case "hr": return [{ type: "text", value: "---" }];
    case "blockquote": return [{ type: "text", value: token.text }];
    case "table": {
      const table = token as Tokens.Table;
      return [{ type: "table", headers: table.header.map((cell) => cell.text), rows: table.rows.map((row) => row.map((cell) => cell.text)) }];
    }
    case "list": {
      const list = token as Tokens.List;
      return [{ type: "list", ordered: list.ordered, start: typeof list.start === "number" ? list.start : undefined, items: list.items.map((item) => item.text) }];
    }
    default: return "text" in token && typeof token.text === "string" ? [{ type: "text", value: token.text }] : [];
  }
}

function inlineTokensToIr(tokens: Token[] | undefined): IRNode[] | null {
  if (!tokens?.length) return null;
  return tokens.flatMap((token) => {
    switch (token.type) {
      case "text": return token.tokens ? inlineTokensToIr(token.tokens) ?? [{ type: "text", value: token.text }] : [{ type: "text", value: token.text }];
      case "strong": return [{ type: "bold", value: token.text }];
      case "codespan": return [{ type: "code_inline", value: token.text }];
      case "link": return [{ type: "link", text: token.text, url: token.href }];
      case "em": return [{ type: "text", value: `*${token.text}*` }];
      case "del": return [{ type: "text", value: `~~${token.text}~~` }];
      default: return "text" in token && typeof token.text === "string" ? [{ type: "text", value: token.text }] : [];
    }
  });
}

// ── MarkerTable interface ─────────────────────────────────────────────────────

/**
 * A set of transform functions that convert each IR node type to a target string.
 * Swap the MarkerTable to change the output format without touching the parser.
 *
 * Implementations: TELEGRAM_HTML_MARKERS, TELEGRAM_RICH_HTML_MARKERS, DISCORD_MARKERS.
 */
export type MarkerTable = {
  text: (text: string) => string;
  bold: (text: string) => string;
  code_inline: (text: string) => string;
  code_block: (text: string, language?: string) => string;
  heading: (text: string, level: number) => string;
  table: (headers: string[], rows: string[][]) => string;
  list: (items: string[], ordered?: boolean, start?: number) => string;
  link: (text: string, url: string) => string;
};

// ── Renderer ──────────────────────────────────────────────────────────────────

/**
 * Walk an IRNode[] and produce a single output string using the given MarkerTable.
 *
 * blockSeparator is inserted AFTER block-level nodes (code_block, heading, table,
 * list) when they are not the last node in the array. Inline nodes (text, bold,
 * code_inline, link) do not receive a trailing separator — their spacing comes
 * from the \n characters embedded in text node values by the paragraph flusher.
 *
 * The correct blockSeparator depends on the rendering path:
 *   parse_mode: HTML  → "\n\n"  (Telegram preserves \n as a line break)
 *   rich_message HTML → "<br><br>"  (\n is whitespace in a real HTML document)
 */
export function renderMarkerString(ir: IRNode[], markers: MarkerTable, blockSeparator = "\n"): string {
  const parts: string[] = [];
  for (let idx = 0; idx < ir.length; idx++) {
    const node = ir[idx];
    const isLast = idx === ir.length - 1;
    switch (node.type) {
      case "text":
        parts.push(markers.text(node.value));
        break;
      case "bold":
        parts.push(markers.bold(node.value));
        break;
      case "link":
        parts.push(markers.link(node.text, node.url));
        break;
      case "code_inline":
        parts.push(markers.code_inline(node.value));
        break;
      case "code_block":
        parts.push(markers.code_block(node.value, node.language));
        if (!isLast) parts.push(blockSeparator);
        break;
      case "heading":
        parts.push(markers.heading(node.value, node.level));
        if (!isLast) parts.push(blockSeparator);
        break;
      case "table":
        parts.push(markers.table(node.headers, node.rows));
        if (!isLast) parts.push(blockSeparator);
        break;
      case "list":
        parts.push(markers.list(node.items, node.ordered, node.start));
        if (!isLast) parts.push(ir[idx + 1]?.type === "list" ? "\n" : blockSeparator);
        break;
    }
  }
  return parts.join("");
}

// ── Table card fallback ───────────────────────────────────────────────────────

/**
 * Render a table as stacked label/value card lines when native <table> is unavailable.
 * Each row becomes: "Label value\n• Field2 value\n• Field3 value"
 * Used by TELEGRAM_HTML_MARKERS (parse_mode:HTML does not support <table>).
 */
function renderTableAsCards(
  headers: string[],
  rows: string[][],
  formatLabel: (label: string) => string,
  bulletPrefix: string,
  renderValue: (text: string) => string,
): string {
  const lines: string[] = [];
  for (const row of rows) {
    const [firstHeader, ...restHeaders] = headers;
    const [firstCell, ...restCells] = row;
    lines.push(`${formatLabel(firstHeader ?? "Item")} ${renderValue(firstCell ?? "")}`);
    for (let c = 0; c < restHeaders.length; c += 1) {
      lines.push(`${bulletPrefix}${formatLabel(restHeaders[c] ?? `Field ${c + 2}`)} ${renderValue(restCells[c] ?? "")}`);
    }
  }
  return lines.join("\n");
}

// ── Discord markers ───────────────────────────────────────────────────────────

/** Passthrough markers that re-emit markdown — used for Discord message delivery. */
export const DISCORD_MARKERS: MarkerTable = {
  text: (text) => text,
  bold: (text) => `**${text}**`,
  code_inline: (text) => `\`${text}\``,
  code_block: (text, language) => "```" + (language ?? "") + "\n" + text + "\n```",
  heading: (text, level) => `${"#".repeat(level)} ${text}`,
  link: (linkText, url) => `[${linkText}](${url})`,
  list: (items, ordered, start = 1) =>
    ordered
      ? items.map((item, i) => `${start + i}. ${item}`).join("\n")
      : items.map((item) => `- ${item}`).join("\n"),
  table: (headers, rows) =>
    renderTableAsCards(headers, rows, (label) => `**${label}:**`, "- ", (text) => text),
};

// ── HTML helpers ──────────────────────────────────────────────────────────────

/** Escape characters that are special in HTML attribute and text contexts. */
function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function safeHref(url: string): string | null {
  const value = url.trim();
  return /^(https?:\/\/|tg:\/\/|mailto:|\/|#)/i.test(value) ? value : null;
}

/**
 * Recursively render inline markdown within a single list item (or table cell).
 *
 * This is a reduced-scope version of renderMarkerString: it re-parses the item
 * string through parseMarkdownToIR and applies only the inline markers. Block
 * nodes that appear inside item text (e.g. sub-bullets indented with spaces)
 * are handled gracefully: headings → bold, code_blocks → code_inline, nested
 * lists → recursively rendered and joined with lineSep.
 *
 * lineSep controls how multi-line content within an item is joined:
 *   "\n"   for parse_mode:HTML (TELEGRAM_HTML_MARKERS path)
 *   "<br>" for rich_message HTML (renderTelegramInlineHtml, TELEGRAM_RICH_HTML_MARKERS path)
 */
function renderInlineMarkerText(
  text: string,
  markers: Pick<MarkerTable, "text" | "bold" | "code_inline" | "link">,
  lineSep = "\n",
): string {
  const parts: string[] = [];
  for (const node of parseMarkdownToIR(text)) {
    if (node.type === "bold") {
      parts.push(markers.bold(node.value));
    } else if (node.type === "code_inline") {
      parts.push(markers.code_inline(node.value));
    } else if (node.type === "link") {
      parts.push(markers.link(node.text, node.url));
    } else if (node.type === "text") {
      parts.push(markers.text(node.value));
    } else if (node.type === "code_block") {
      // Degrade to inline code inside a list item — block fences don't render well inline.
      parts.push(markers.code_inline(node.value));
    } else if (node.type === "heading") {
      parts.push(markers.bold(node.value));
    } else if (node.type === "list") {
      const rendered = node.items.map((item, index) => {
        const prefix = node.ordered ? `${(node.start ?? 1) + index}. ` : "• ";
        return `${prefix}${renderInlineMarkerText(item, markers, lineSep)}`;
      }).join(lineSep);
      parts.push(parts.length ? `${lineSep}${rendered}` : rendered);
    } else if (node.type === "table") {
      // Flatten table cells to space-separated text inside a list item.
      parts.push(node.rows.flat().map((cell) => renderInlineMarkerText(cell, markers, lineSep)).join(" "));
    }
  }
  return parts.join("");
}

// ── Telegram rich HTML inline renderer ───────────────────────────────────────

/**
 * Inline renderer for TELEGRAM_RICH_HTML_MARKERS list items.
 *
 * The rich_message HTML path sends a real HTML document — \n collapses to
 * whitespace. All line breaks within inline content must be <br>, hence the
 * explicit text conversion and lineSep="<br>".
 */
const renderTelegramInlineHtml = (text: string) => renderInlineMarkerText(text, {
  text: (value) => escapeHtml(value).replace(/\n\n/g, "<br><br>").replace(/\n/g, "<br>"),
  bold: (value) => `<b>${escapeHtml(value)}</b>`,
  code_inline: (value) => `<code>${escapeHtml(value)}</code>`,
  link: (linkText, url) => safeHref(url)
    ? `<a href="${escapeHtml(safeHref(url)!)}">${escapeHtml(linkText)}</a>`
    : `${escapeHtml(linkText)} (${escapeHtml(url)})`,
}, "<br>");

const renderTelegramInlineText = (text: string) => renderInlineMarkerText(text, {
  text: escapeHtml,
  bold: (value) => `<b>${escapeHtml(value)}</b>`,
  code_inline: (value) => `<code>${escapeHtml(value)}</code>`,
  link: (linkText, url) => safeHref(url)
    ? `<a href="${escapeHtml(safeHref(url)!)}">${escapeHtml(linkText)}</a>`
    : `${escapeHtml(linkText)} (${escapeHtml(url)})`,
}, "\n");

// ── Telegram parse_mode:HTML markers (Path A) ─────────────────────────────────

/**
 * MarkerTable for Telegram's parse_mode:"HTML" delivery path (sendEntityMessages).
 *
 * In this mode Telegram's own HTML parser handles the content. It preserves
 * literal \n as line breaks, so no <br> conversion is needed. Tables are NOT
 * supported — they fall back to renderTableAsCards (stacked label/value lines).
 *
 * Supported Telegram HTML tags: <b>, <i>, <code>, <pre>, <a href>, <s>, <u>.
 * Unsupported: <h1>, <table>, <ul>, <li>, etc.
 */
export const TELEGRAM_HTML_MARKERS: MarkerTable = {
  text: (text) => escapeHtml(text),
  bold: (text) => `<b>${escapeHtml(text)}</b>`,
  code_inline: (text) => `<code>${escapeHtml(text)}</code>`,
  code_block: (text, language) => language
    ? `<pre language="${escapeHtml(language)}">${escapeHtml(text)}</pre>`
    : `<pre>${escapeHtml(text)}</pre>`,
  // Telegram has no heading tags — render as bold.
  heading: (text) => `<b>${escapeHtml(text)}</b>`,
  link: (linkText, url) => safeHref(url)
    ? `<a href="${escapeHtml(safeHref(url)!)}">${escapeHtml(linkText)}</a>`
    : `${escapeHtml(linkText)} (${escapeHtml(url)})`,
  // List items joined with \n — Telegram's HTML parser renders \n as a line break.
  list: (items, ordered, start = 1) =>
    ordered
      ? items.map((item, i) => `${start + i}. ${renderTelegramInlineText(item)}`).join("\n")
      : items.map((item) => `• ${renderTelegramInlineText(item)}`).join("\n"),
  // Tables unsupported in parse_mode:HTML — degrade to card-style stacked lines.
  table: (headers, rows) =>
    renderTableAsCards(headers, rows, (label) => `<b>${escapeHtml(label)}</b>`, "• ", renderTelegramInlineHtml),
};

// ── Telegram rich_message HTML markers (Path B) ───────────────────────────────

/**
 * Convert a markdown string containing a GFM table to a rich HTML string
 * suitable for sendRichMessage (Telegram Bot API 10.1+).
 *
 * The block separator is "<br><br>" because the HTML document's whitespace
 * normalisation collapses plain \n to a space.
 */
export function markdownTableToRichHtml(markdown: string): string {
  return renderMarkerString(parseMarkdownToIR(markdown), TELEGRAM_RICH_HTML_MARKERS, "<br><br>");
}

/** Render a document before chunking so list starts and block boundaries survive delivery. */
export function markdownToTelegramHtmlChunks(markdown: string, limit = 4096): string[] {
  const nodes = parseMarkdownToIR(markdown).flatMap((node) => splitOversizedNode(node, limit));
  const chunks: string[] = [];
  let current: IRNode[] = [];
  const renderedLength = (value: string) => value
    .replace(/<[^>]+>/g, "")
    .replace(/&(?:amp|lt|gt|quot);/g, "x").length;
  const flush = () => {
    if (current.length) chunks.push(renderMarkerString(current, TELEGRAM_HTML_MARKERS, "\n\n"));
    current = [];
  };
  for (const node of nodes) {
    if (node.type === "list") {
      const start = node.start ?? 1;
      for (let index = 0; index < node.items.length; index += 1) {
        const itemNode: IRNode = { ...node, start: start + index, items: [node.items[index]!] };
        const candidate = renderMarkerString([...current, itemNode], TELEGRAM_HTML_MARKERS, "\n\n");
        if (current.length && renderedLength(candidate) > limit) flush();
        current.push(itemNode);
      }
      continue;
    }
    const candidate = renderMarkerString([...current, node], TELEGRAM_HTML_MARKERS, "\n\n");
    if (current.length && renderedLength(candidate) > limit) flush();
    current.push(node);
  }
  flush();
  return chunks.length ? chunks : [""];
}

function splitOversizedNode(node: IRNode, limit: number): IRNode[] {
  if (node.type === "list") {
    const start = node.start ?? 1;
    return node.items.flatMap((item, index) => {
      const itemNode: IRNode = { ...node, start: start + index, items: [item] };
      if (item.length <= limit) return [itemNode];
      const prefix = node.ordered ? `${start + index}. ` : "• ";
      return splitOversizedNode({ type: "text", value: prefix + item }, limit);
    });
  }
  if (!("value" in node) || typeof node.value !== "string" || node.value.length <= limit) return [node];
  const values: string[] = [];
  let value = "";
  for (const character of node.value) {
    if (value.length + character.length > limit && value) {
      values.push(value);
      value = "";
    }
    value += character;
  }
  if (value) values.push(value);
  return values.map((part) => ({ ...node, value: part } as IRNode));
}

/**
 * MarkerTable for Telegram's rich_message HTML delivery path (sendRichMessage).
 *
 * sendRichMessage wraps the HTML in a full document context where whitespace
 * normalisation applies — \n is treated as a space, not a line break. Every
 * break must be an explicit <br> tag. This affects text nodes, list item
 * joiners, and the block separator passed to renderMarkerString.
 *
 * Tables ARE supported here via native <table bordered striped> markup
 * (Telegram Bot API 10.1 feature). If sendRichMessage fails or is unavailable,
 * messageDelivery.ts falls back to sendEntityMessages (Path A / TELEGRAM_HTML_MARKERS).
 */
export const TELEGRAM_RICH_HTML_MARKERS: MarkerTable = {
  // \n → <br>: required because this HTML is parsed as a document, not by Telegram's custom parser.
  text: (text) => escapeHtml(text).replace(/\n\n/g, "<br><br>").replace(/\n/g, "<br>"),
  bold: (text) => `<b>${escapeHtml(text)}</b>`,
  code_inline: (text) => `<code>${escapeHtml(text)}</code>`,
  // <pre> preserves internal whitespace so no \n→<br> conversion needed inside code blocks.
  code_block: (text, language) => language
    ? `<pre language="${escapeHtml(language)}">${escapeHtml(text)}</pre>`
    : `<pre>${escapeHtml(text)}</pre>`,
  heading: (text) => `<b>${escapeHtml(text)}</b>`,
  link: (linkText, url) => safeHref(url)
    ? `<a href="${escapeHtml(safeHref(url)!)}">${escapeHtml(linkText)}</a>`
    : `${escapeHtml(linkText)} (${escapeHtml(url)})`,
  // List items joined with <br> — \n would be collapsed in the document context.
  list: (items, ordered, start = 1) =>
    ordered
      ? items.map((item, i) => `${start + i}. ${renderTelegramInlineHtml(item)}`).join("<br>")
      : items.map((item) => `• ${renderTelegramInlineHtml(item)}`).join("<br>"),
  // Native table with bordered + striped attributes for Telegram Bot API 10.1.
  table: (headers, rows) =>
    `<table bordered striped>` +
    `<thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead>` +
    `<tbody>${rows.map((row) => `<tr>${headers.map((_, i) => `<td>${escapeHtml(row[i] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody>` +
    `</table>`,
};

// ── Misc exports ──────────────────────────────────────────────────────────────

export function discordMarkdownIrEnabled(): boolean {
  return process.env.DISCORD_MARKDOWN_IR_ENABLED === "true";
}
