import type { IRNode, IRListItem } from "./types.js";

/** Escape characters that are special in HTML contexts. */
export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Sanitize link URL to prevent javascript: or data: XSS vectors in HTML. */
export function isSafeUrl(url: string): boolean {
  return /^(https?:\/\/|tg:\/\/|mailto:|^\/|^#)/i.test(url.trim());
}

/**
 * Format a table as stacked cards (Telegram parse_mode:HTML and Discord fallback).
 */

function renderInlineSpansHtml(text: string): string {
  // Parses inline spans: **bold**, *italic*, ~~strikethrough~~, `code`, [link](url)
  // Escapes characters not inside HTML tags.
  let i = 0;
  let out = "";
  while (i < text.length) {
    if (text.startsWith("**", i)) {
      const end = text.indexOf("**", i + 2);
      if (end !== -1) {
        const inner = text.slice(i + 2, end);
        out += "<b>" + renderInlineSpansHtml(inner) + "</b>";
        i = end + 2;
        continue;
      }
    }
    if (text.startsWith("~~", i)) {
      const end = text.indexOf("~~", i + 2);
      if (end !== -1) {
        const inner = text.slice(i + 2, end);
        out += "<s>" + renderInlineSpansHtml(inner) + "</s>";
        i = end + 2;
        continue;
      }
    }
    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      if (end !== -1) {
        const inner = text.slice(i + 1, end);
        out += "<code>" + escapeHtml(inner) + "</code>";
        i = end + 1;
        continue;
      }
    }
    if (text[i] === "[") {
      const closeBracket = text.indexOf("]", i + 1);
      if (closeBracket !== -1 && text[closeBracket + 1] === "(") {
        const closeParen = text.indexOf(")", closeBracket + 2);
        if (closeParen !== -1) {
          const linkText = text.slice(i + 1, closeBracket);
          const url = text.slice(closeBracket + 2, closeParen);
          if (isSafeUrl(url)) {
            out += '<a href="' + escapeHtml(url) + '">' + escapeHtml(linkText) + "</a>";
          } else {
            out += escapeHtml(linkText) + " (" + escapeHtml(url) + ")";
          }
          i = closeParen + 1;
          continue;
        }
      }
    }
    if (text.startsWith("*", i) && !text.startsWith("**", i)) {
      const end = text.indexOf("*", i + 1);
      if (end !== -1) {
        const inner = text.slice(i + 1, end);
        out += "<i>" + renderInlineSpansHtml(inner) + "</i>";
        i = end + 1;
        continue;
      }
    }
    out += escapeHtml(text[i]);
    i++;
  }
  return out;
}

export function renderTableAsCards(
  headers: string[],
  rows: string[][],
  formatLabel: (label: string) => string,
  bullet = "• ",
  formatValue: (val: string) => string = (v) => v,
): string {
  const cards: string[] = [];
  for (const row of rows) {
    const lines: string[] = [];
    for (let c = 0; c < row.length; c++) {
      const header = headers[c] || `Field ${c + 1}`;
      const val = row[c] ?? "";
      lines.push(`${bullet}${formatLabel(header)}: ${formatValue(val)}`);
    }
    cards.push(lines.join("\n"));
  }
  return cards.join("\n\n");
}

/**
 * Render IRNode[] to Telegram parse_mode: "HTML" string.
 */
export function renderTelegramHtml(ir: IRNode[]): string {
  const parts: string[] = [];

  for (let idx = 0; idx < ir.length; idx++) {
    const node = ir[idx];
    const isLast = idx === ir.length - 1;

    switch (node.type) {
      case "text":
        parts.push(escapeHtml(node.value));
        break;

      case "bold":
        parts.push(`<b>${escapeHtml(node.value)}</b>`);
        break;

      case "italic":
        parts.push(`<i>${escapeHtml(node.value)}</i>`);
        break;

      case "strikethrough":
        parts.push(`<s>${escapeHtml(node.value)}</s>`);
        break;

      case "code_inline":
        parts.push(`<code>${escapeHtml(node.value)}</code>`);
        break;

      case "code_block":
        parts.push(
          node.language
            ? `<pre language="${escapeHtml(node.language)}">${escapeHtml(node.value)}</pre>`
            : `<pre>${escapeHtml(node.value)}</pre>`
        );
        if (!isLast) parts.push("\n");
        break;

      case "heading":
        parts.push(`<b>${escapeHtml(node.value)}</b>`);
        if (!isLast) parts.push("\n");
        break;

      case "blockquote":
        parts.push(`<blockquote>${escapeHtml(node.value)}</blockquote>`);
        if (!isLast) parts.push("\n");
        break;

      case "hr":
        parts.push("---");
        if (!isLast) parts.push("\n");
        break;

      case "link":
        if (isSafeUrl(node.url)) {
          parts.push(`<a href="${escapeHtml(node.url)}">${escapeHtml(node.text)}</a>`);
        } else {
          parts.push(`${escapeHtml(node.text)} (${escapeHtml(node.url)})`);
        }
        break;

      case "table":
        parts.push(
          renderTableAsCards(
            node.headers,
            node.rows,
            (h) => `<b>${escapeHtml(h)}</b>`,
            "• ",
            (v) => escapeHtml(v)
          )
        );
        if (!isLast) parts.push("\n");
        break;

      case "list": {
        const start = node.start ?? 1;
        const listLines: string[] = [];
        for (let i = 0; i < node.items.length; i++) {
          const item = node.items[i];
          const prefix = node.ordered ? `${start + i}. ` : "• ";
          if (typeof item === "string") {
            listLines.push(`${prefix}${renderInlineSpansHtml(item)}`);
          } else {
            let taskPrefix = "";
            if (item.checked === true) taskPrefix = "☑ ";
            else if (item.checked === false) taskPrefix = "☐ ";

            let line = `${prefix}${taskPrefix}${renderInlineSpansHtml(item.text)}`;
            if (item.sublist && item.sublist.type === "list") {
              const sublist = item.sublist;
              const subStart = sublist.start ?? 1;
              const subLines = sublist.items.map((subItem, si) => {
                const subPrefix = sublist.ordered ? `    ${subStart + si}. ` : "    • ";
                const subText = typeof subItem === "string" ? subItem : subItem.text;
                return `${subPrefix}${renderInlineSpansHtml(subText)}`;
              });
              line += "\n" + subLines.join("\n");
            }
            listLines.push(line);
          }
        }
        parts.push(listLines.join("\n"));
        if (!isLast) parts.push("\n");
        break;
      }
    }
  }

  return parts.join("");
}

/**
 * Render IRNode[] to Telegram rich_message HTML (Telegram Bot API 10.1+).
 */
export function renderTelegramRichHtml(ir: IRNode[]): string {
  const parts: string[] = [];

  for (let idx = 0; idx < ir.length; idx++) {
    const node = ir[idx];
    const isLast = idx === ir.length - 1;

    switch (node.type) {
      case "text":
        parts.push(escapeHtml(node.value).replace(/\n\n/g, "<br><br>").replace(/\n/g, "<br>"));
        break;

      case "bold":
        parts.push(`<b>${escapeHtml(node.value)}</b>`);
        break;

      case "italic":
        parts.push(`<i>${escapeHtml(node.value)}</i>`);
        break;

      case "strikethrough":
        parts.push(`<s>${escapeHtml(node.value)}</s>`);
        break;

      case "code_inline":
        parts.push(`<code>${escapeHtml(node.value)}</code>`);
        break;

      case "code_block":
        parts.push(
          node.language
            ? `<pre language="${escapeHtml(node.language)}">${escapeHtml(node.value)}</pre>`
            : `<pre>${escapeHtml(node.value)}</pre>`
        );
        if (!isLast) parts.push("<br><br>");
        break;

      case "heading":
        parts.push(`<b>${escapeHtml(node.value)}</b>`);
        if (!isLast) parts.push("<br><br>");
        break;

      case "blockquote":
        parts.push(`<blockquote>${escapeHtml(node.value)}</blockquote>`);
        if (!isLast) parts.push("<br><br>");
        break;

      case "hr":
        parts.push("---");
        if (!isLast) parts.push("<br><br>");
        break;

      case "link":
        if (isSafeUrl(node.url)) {
          parts.push(`<a href="${escapeHtml(node.url)}">${escapeHtml(node.text)}</a>`);
        } else {
          parts.push(`${escapeHtml(node.text)} (${escapeHtml(node.url)})`);
        }
        break;

      case "table": {
        let tableHtml = "<table bordered striped>";
        if (node.headers.length > 0) {
          tableHtml += "<thead><tr>";
          for (const h of node.headers) tableHtml += `<th>${escapeHtml(h)}</th>`;
          tableHtml += "</tr></thead>";
        }
        tableHtml += "<tbody>";
        for (const row of node.rows) {
          tableHtml += "<tr>";
          for (const c of row) tableHtml += `<td>${escapeHtml(c)}</td>`;
          tableHtml += "</tr>";
        }
        tableHtml += "</tbody></table>";
        parts.push(tableHtml);
        if (!isLast) parts.push("<br><br>");
        break;
      }

      case "list": {
        const start = node.start ?? 1;
        const listLines: string[] = [];
        for (let i = 0; i < node.items.length; i++) {
          const item = node.items[i];
          const prefix = node.ordered ? `${start + i}. ` : "• ";
          if (typeof item === "string") {
            listLines.push(`${prefix}${escapeHtml(item)}`);
          } else {
            let taskPrefix = "";
            if (item.checked === true) taskPrefix = "☑ ";
            else if (item.checked === false) taskPrefix = "☐ ";

            let line = `${prefix}${taskPrefix}${escapeHtml(item.text)}`;
            if (item.sublist && item.sublist.type === "list") {
              const sublist = item.sublist;
              const subStart = sublist.start ?? 1;
              const subLines = sublist.items.map((subItem, si) => {
                const subPrefix = sublist.ordered ? `&nbsp;&nbsp;&nbsp;&nbsp;${subStart + si}. ` : "&nbsp;&nbsp;&nbsp;&nbsp;• ";
                const subText = typeof subItem === "string" ? subItem : subItem.text;
                return `${subPrefix}${escapeHtml(subText)}`;
              });
              line += "<br>" + subLines.join("<br>");
            }
            listLines.push(line);
          }
        }
        parts.push(listLines.join("<br>"));
        if (!isLast) parts.push("<br><br>");
        break;
      }
    }
  }

  return parts.join("");
}

/**
 * Render IRNode[] to Discord Markdown format.
 */
export function renderDiscord(ir: IRNode[]): string {
  const parts: string[] = [];

  for (let idx = 0; idx < ir.length; idx++) {
    const node = ir[idx];
    const isLast = idx === ir.length - 1;

    switch (node.type) {
      case "text":
        parts.push(node.value);
        break;

      case "bold":
        parts.push(`**${node.value}**`);
        break;

      case "italic":
        parts.push(`*${node.value}*`);
        break;

      case "strikethrough":
        parts.push(`~~${node.value}~~`);
        break;

      case "code_inline":
        parts.push("`" + node.value + "`");
        break;

      case "code_block":
        parts.push("\n```" + (node.language || "") + "\n" + node.value + "\n```\n");
        break;

      case "heading":
        parts.push(`${"#".repeat(node.level)} ${node.value}`);
        if (!isLast) parts.push("\n");
        break;

      case "blockquote":
        parts.push(`> ${node.value}`);
        if (!isLast) parts.push("\n");
        break;

      case "hr":
        parts.push("---");
        if (!isLast) parts.push("\n");
        break;

      case "link":
        parts.push(`[${node.text}](${node.url})`);
        break;

      case "table":
        parts.push(renderTableAsCards(node.headers, node.rows, (h) => `**${h}**`, "• "));
        if (!isLast) parts.push("\n");
        break;

      case "list": {
        const start = node.start ?? 1;
        const listLines: string[] = [];
        for (let i = 0; i < node.items.length; i++) {
          const item = node.items[i];
          const prefix = node.ordered ? `${start + i}. ` : "- ";
          if (typeof item === "string") {
            listLines.push(`${prefix}${item}`);
          } else {
            let taskPrefix = "";
            if (item.checked === true) taskPrefix = "[x] ";
            else if (item.checked === false) taskPrefix = "[ ] ";

            let line = `${prefix}${taskPrefix}${item.text}`;
            if (item.sublist && item.sublist.type === "list") {
              const sublist = item.sublist;
              const subStart = sublist.start ?? 1;
              const subLines = sublist.items.map((subItem, si) => {
                const subPrefix = sublist.ordered ? `  ${subStart + si}. ` : "  - ";
                const subText = typeof subItem === "string" ? subItem : subItem.text;
                return `${subPrefix}${subText}`;
              });
              line += "\n" + subLines.join("\n");
            }
            listLines.push(line);
          }
        }
        parts.push(listLines.join("\n"));
        if (!isLast) parts.push("\n");
        break;
      }
    }
  }

  return parts.join("");
}
