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
  | { type: "bold"; value: string; children?: IRNode[] }
  | { type: "italic"; value: string; children?: IRNode[] }
  | { type: "strikethrough"; value: string; children?: IRNode[] }
  | { type: "code_inline"; value: string }
  | { type: "code_block"; value: string; language?: string }
  | { type: "heading"; level: number; value: string }
  | { type: "table"; headers: string[]; rows: string[][]; headerChildren?: IRNode[][]; rowChildren?: IRNode[][][] }
  | { type: "list"; items: string[]; children: IRNode[][]; ordered?: boolean; start?: number }
  | { type: "link"; text: string; url: string };

// ── Block parser ──────────────────────────────────────────────────────────────

/** The small parser boundary used by the surface-neutral renderer. */
export interface MarkdownParser {
  parse(markdown: string): IRNode[];
}

/** Marked adapter. Its token types do not leave this module. */
export class MarkedMarkdownParser implements MarkdownParser {
  parse(markdown: string): IRNode[] {
    return mergeAdjacentOrderedLists(blockTokensToIr(marked.lexer(markdown), "\n\n"));
  }
}

const productionMarkdownParser: MarkdownParser = new MarkedMarkdownParser();

/** The single production parser boundary. */
export function parseMarkdownToIR(markdown: string): IRNode[] {
  return productionMarkdownParser.parse(markdown);
}

function markedTokenToIr(token: Token): IRNode[] {
  switch (token.type) {
    case "heading": return [{ type: "heading", level: token.depth, value: token.text }];
    case "code": return [{ type: "code_block", value: token.text, language: token.lang?.split(/\s+/, 1)[0] || undefined }];
    case "paragraph": return inlineTokensToIr(token.tokens) || [{ type: "text", value: token.text }];
    case "html": return [{ type: "text", value: token.raw }];
    case "hr": return [{ type: "text", value: "---" }];
    case "blockquote": return quoteNodes(blockTokensToIr((token as Tokens.Blockquote).tokens, "\n\n"));
    case "table": {
      const table = token as Tokens.Table;
      return [{
        type: "table",
        headers: table.header.map((cell) => cell.text),
        rows: table.rows.map((row) => row.map((cell) => cell.text)),
        headerChildren: table.header.map((cell) => inlineTokensToIr(cell.tokens) ?? [{ type: "text", value: cell.text }]),
        rowChildren: table.rows.map((row) => row.map((cell) => inlineTokensToIr(cell.tokens) ?? [{ type: "text", value: cell.text }])),
      }];
    }
    case "list": {
      const list = token as Tokens.List;
      return [{
        type: "list",
        ordered: list.ordered,
        start: typeof list.start === "number" ? list.start : undefined,
        items: list.items.map((item) => taskPrefix(item) + item.text.trimEnd()),
        children: list.items.map((item) => {
          const children = blockTokensToIr(item.tokens, "\n");
          return item.task ? [{ type: "text", value: taskPrefix(item) }, ...children] : children;
        }),
      }];
    }
    default: return "text" in token && typeof token.text === "string" ? [{ type: "text", value: token.text }] : [];
  }
}

/**
 * Convert sibling block tokens. Marked drops the blank line between two
 * paragraphs, so the separator is restored here as text; block nodes get their
 * spacing from renderMarkerString.
 */
function blockTokensToIr(tokens: Token[], paragraphSeparator: string): IRNode[] {
  const nodes: IRNode[] = [];
  for (const token of tokens) {
    const group = token.type === "text" && token.tokens
      ? inlineTokensToIr(token.tokens) ?? [{ type: "text", value: token.text }]
      : markedTokenToIr(token);
    if (!group.length) continue;
    const previous = nodes.at(-1);
    if (previous && !isBlockNode(previous) && !isBlockNode(group[0]!)) nodes.push({ type: "text", value: paragraphSeparator });
    nodes.push(...group);
  }
  return nodes;
}

function taskPrefix(item: Tokens.ListItem): string {
  return item.task ? (item.checked ? "[x] " : "[ ] ") : "";
}

/** Neither surface path has a quote node; keep the quote marker on every line. */
function quoteNodes(nodes: IRNode[]): IRNode[] {
  return [
    { type: "text", value: "> " },
    ...nodes.map((node) => node.type === "text" ? { ...node, value: node.value.replace(/\n/g, "\n> ") } : node),
  ];
}

/**
 * Models commonly put blank lines between each `1.` item. Marked correctly
 * emits separate adjacent lists, but delivery should retain the author's one
 * logical sequence. A paragraph, heading, or any other block prevents merging.
 */
function mergeAdjacentOrderedLists(nodes: IRNode[]): IRNode[] {
  const merged: IRNode[] = [];
  for (const node of nodes) {
    const previous = merged.at(-1);
    if (node.type === "list" && node.ordered && previous?.type === "list" && previous.ordered) {
      previous.items.push(...node.items);
      previous.children.push(...node.children);
    } else {
      merged.push(node);
    }
  }
  return merged;
}

function inlineTokensToIr(tokens: Token[] | undefined): IRNode[] | null {
  if (!tokens?.length) return null;
  return tokens.flatMap((token) => {
    switch (token.type) {
      case "text": return token.tokens ? inlineTokensToIr(token.tokens) ?? [{ type: "text", value: token.text }] : [{ type: "text", value: token.text }];
      case "strong": return [{ type: "bold", value: token.text, children: nestedInlineChildren(token.tokens, token.text) }];
      case "codespan": return [{ type: "code_inline", value: token.text }];
      case "link": return [{ type: "link", text: token.text, url: token.href }];
      case "image": return [{ type: "link", text: token.text || token.href, url: token.href }];
      case "br": return [{ type: "text", value: "\n" }];
      case "em": return [{ type: "italic", value: token.text, children: nestedInlineChildren(token.tokens, token.text) }];
      case "del": return [{ type: "strikethrough", value: token.text, children: nestedInlineChildren(token.tokens, token.text) }];
      default: return "text" in token && typeof token.text === "string" ? [{ type: "text", value: token.text }] : [];
    }
  });
}

function nestedInlineChildren(tokens: Token[] | undefined, text: string): IRNode[] | undefined {
  const children = inlineTokensToIr(tokens);
  return children?.every((child) => child.type === "text") && children.map((child) => child.value).join("") === text
    ? undefined
    : children ?? undefined;
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
  italic: (text: string) => string;
  strikethrough: (text: string) => string;
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
    const previous = ir[idx - 1];
    if (isBlockNode(node) && previous && !isBlockNode(previous)) {
      parts.push(node.type === "heading" ? blockSeparator : blockSeparator.includes("<br>") ? "<br>" : "\n");
    }
    switch (node.type) {
      case "text":
        parts.push(markers.text(node.value));
        break;
      case "bold":
        parts.push(renderInlineNode(node, markers, "bold"));
        break;
      case "italic":
        parts.push(renderInlineNode(node, markers, "italic"));
        break;
      case "strikethrough":
        parts.push(renderInlineNode(node, markers, "strikethrough"));
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
        parts.push(renderTable(node, markers));
        if (!isLast) parts.push(blockSeparator);
        break;
      case "list":
        parts.push(renderList(node, markers, blockSeparator));
        if (!isLast) parts.push(ir[idx + 1]?.type === "list" ? "\n" : blockSeparator);
        break;
    }
  }
  return parts.join("");
}

function renderInlineNode(
  node: Extract<IRNode, { type: "bold" | "italic" | "strikethrough" }>,
  markers: MarkerTable,
  kind: "bold" | "italic" | "strikethrough",
): string {
  if (!node.children?.length) return markers[kind](node.value);
  const content = renderMarkerString(node.children, markers);
  if (markers === DISCORD_MARKERS) return kind === "bold" ? `**${content}**` : kind === "italic" ? `*${content}*` : `~~${content}~~`;
  if (markers === TELEGRAM_HTML_MARKERS || markers === TELEGRAM_RICH_HTML_MARKERS) {
    const tag = kind === "bold" ? "b" : kind === "italic" ? "i" : "s";
    return `<${tag}>${content}</${tag}>`;
  }
  return markers[kind](content);
}

function isBlockNode(node: IRNode): boolean {
  return node.type === "code_block" || node.type === "heading" || node.type === "table" || node.type === "list";
}

function renderList(node: Extract<IRNode, { type: "list" }>, markers: MarkerTable, blockSeparator: string): string {
  const lineSeparator = blockSeparator.includes("<br>") ? "<br>" : "\n";
  return node.items.map((item, index) => {
    const prefix = node.ordered ? `${(node.start ?? 1) + index}. ` : markers === DISCORD_MARKERS ? "- " : "• ";
    const children = node.children[index];
    const body = children?.length
      ? renderMarkerString(children, markers, lineSeparator)
      : markers.text(item);
    return `${prefix}${body}`;
  }).join(lineSeparator);
}

function renderTable(node: Extract<IRNode, { type: "table" }>, markers: MarkerTable): string {
  if (!node.headerChildren || !node.rowChildren) return markers.table(node.headers, node.rows);
  const renderCell = (children: IRNode[]) => renderMarkerString(children, markers);
  if (markers === TELEGRAM_HTML_MARKERS) {
    return node.rows.map((row, rowIndex) => row.map((cell, cellIndex) => {
      const label = `<b>${escapeHtml(node.headers[cellIndex] ?? `Field ${cellIndex + 1}`)}</b>`;
      const value = renderCell(node.rowChildren![rowIndex]?.[cellIndex] ?? [{ type: "text", value: cell }]);
      return `${cellIndex === 0 ? "" : "• "}${label} ${value}`;
    }).join("\n")).join("\n");
  }
  if (markers === TELEGRAM_RICH_HTML_MARKERS) {
    return `<table bordered striped><thead><tr>${node.headers.map((header, index) => `<th>${renderCell(node.headerChildren![index] ?? [{ type: "text", value: header }])}</th>`).join("")}</tr></thead><tbody>${node.rows.map((row, rowIndex) => `<tr>${row.map((cell, cellIndex) => `<td>${renderCell(node.rowChildren![rowIndex]?.[cellIndex] ?? [{ type: "text", value: cell }])}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  }
  if (markers === DISCORD_MARKERS) {
    return node.rows.map((row, rowIndex) => row.map((cell, cellIndex) => {
      const label = `**${node.headers[cellIndex] ?? `Field ${cellIndex + 1}`}:**`;
      const value = renderCell(node.rowChildren![rowIndex]?.[cellIndex] ?? [{ type: "text", value: cell }]);
      return `${cellIndex === 0 ? "" : "- "}${label} ${value}`;
    }).join("\n")).join("\n");
  }
  return markers.table(node.headers, node.rows);
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
  italic: (text) => `*${text}*`,
  strikethrough: (text) => `~~${text}~~`,
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

// Table-cell strings are escaped at the renderer boundary. List content never
// returns through this helper: it retains the parsed child blocks above.
const renderTelegramInlineHtml = (text: string) =>
  escapeHtml(text).replace(/\n\n/g, "<br><br>").replace(/\n/g, "<br>");

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
  italic: (text) => `<i>${escapeHtml(text)}</i>`,
  strikethrough: (text) => `<s>${escapeHtml(text)}</s>`,
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
      ? items.map((item, i) => `${start + i}. ${escapeHtml(item)}`).join("\n")
      : items.map((item) => `• ${escapeHtml(item)}`).join("\n"),
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

/** Telegram applies its message limit after entity parsing: tags do not count and an entity is one character. */
function telegramVisibleLength(html: string): number {
  return html.replace(/<[^>]+>/g, "").replace(/&(?:amp|lt|gt|quot);/g, "x").length;
}

function telegramNodeLength(node: IRNode): number {
  return telegramVisibleLength(renderMarkerString([node], TELEGRAM_HTML_MARKERS, "\n\n"));
}

/** Render a document before chunking so list starts and block boundaries survive delivery. */
export function markdownToTelegramHtmlChunks(markdown: string, limit = 4096): string[] {
  const nodes = parseMarkdownToIR(markdown).flatMap((node) => splitOversizedNode(node, limit));
  const chunks: string[] = [];
  let current: IRNode[] = [];
  const flush = () => {
    // A chunk boundary replaces the paragraph separator next to it.
    const rendered = renderMarkerString(current, TELEGRAM_HTML_MARKERS, "\n\n").trim();
    if (rendered) chunks.push(rendered);
    current = [];
  };
  for (const node of nodes) {
    const candidate = renderMarkerString([...current, node], TELEGRAM_HTML_MARKERS, "\n\n");
    if (current.length && telegramVisibleLength(candidate) > limit) flush();
    current.push(node);
  }
  flush();
  return chunks.length ? chunks : [""];
}

/** Break a node that cannot fit one message into nodes that each fit. Lists always split per item so counters continue. */
function splitOversizedNode(node: IRNode, limit: number): IRNode[] {
  if (node.type === "list") {
    const start = node.start ?? 1;
    return node.items.flatMap((item, index) => {
      const itemNode: IRNode = { ...node, start: start + index, items: [item], children: [node.children[index] ?? []] };
      if (telegramNodeLength(itemNode) <= limit) return [itemNode];
      const prefix = node.ordered ? `${start + index}. ` : "• ";
      return splitOversizedNode({ type: "text", value: prefix + item }, limit);
    });
  }
  if (node.type === "table") {
    if (telegramNodeLength(node) <= limit) return [node];
    const parts: IRNode[] = [];
    let from = 0;
    const slice = (to: number): IRNode => ({ ...node, rows: node.rows.slice(from, to), rowChildren: node.rowChildren?.slice(from, to) });
    for (let to = 1; to <= node.rows.length; to += 1) {
      if (to - from > 1 && telegramNodeLength(slice(to)) > limit) {
        parts.push(slice(to - 1));
        from = to - 1;
      }
    }
    parts.push(slice(node.rows.length));
    return parts.flatMap((part) => telegramNodeLength(part) <= limit
      ? [part]
      : splitOversizedNode({ type: "text", value: renderMarkerString([part], DISCORD_MARKERS) }, limit));
  }
  if (!("value" in node) || typeof node.value !== "string" || node.value.length <= limit) return [node];
  const values: string[] = [];
  let rest = node.value;
  while (rest.length > limit) {
    // Prefer a line or word boundary in the second half; never cut a surrogate pair.
    let cut = /[\uD800-\uDBFF]/.test(rest[limit - 1]!) ? limit - 1 : limit;
    const window = rest.slice(0, cut);
    const boundary = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(" ")) + 1;
    if (boundary > limit / 2) cut = window.lastIndexOf("\n") + 1 > limit / 2 ? window.lastIndexOf("\n") + 1 : boundary;
    values.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) values.push(rest);
  // The parts carry the text themselves; stale children would render the whole node again.
  return values.map((part) => ({ ...node, value: part, ...("children" in node ? { children: undefined } : {}) } as IRNode));
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
  italic: (text) => `<i>${escapeHtml(text)}</i>`,
  strikethrough: (text) => `<s>${escapeHtml(text)}</s>`,
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
