import type { IRNode } from "./markdownIR.js";

export function splitTelegramText(text: string, limit = 3500): string[] {
  const value = String(text || "");
  if (value.length <= limit) return [value];

  const chunks: string[] = [];
  let remaining = value;

  while (remaining.length > limit) {
    // Try to split at a natural boundary
    let splitAt = -1;

    // 1. Try double newline (paragraph)
    splitAt = remaining.lastIndexOf("\n\n", limit);

    // 2. Try single newline
    if (splitAt < Math.floor(limit * 0.7)) {
      splitAt = remaining.lastIndexOf("\n", limit);
    }

    // 3. Try space
    if (splitAt < Math.floor(limit * 0.7)) {
      splitAt = remaining.lastIndexOf(" ", limit);
    }

    // 4. Force split if no good boundary found
    if (splitAt <= 0) {
      splitAt = limit;
    }

    let chunk = remaining.slice(0, splitAt).trim();

    // Handle code blocks: if we have an odd number of triple backticks,
    // we are likely splitting inside a code block.
    const backticks = (chunk.match(/```/g) || []).length;
    if (backticks % 2 !== 0) {
      // Find the last triple backtick before the split
      const lastBacktick = chunk.lastIndexOf("```");
      if (lastBacktick > Math.floor(limit * 0.5)) {
        // Split right before the code block if it's not too far back
        splitAt = lastBacktick;
        chunk = remaining.slice(0, splitAt).trim();
      } else {
        // Otherwise, close the code block in this chunk and reopen in the next
        chunk += "\n```";
        remaining = "```\n" + remaining.slice(splitAt).trimStart();
        chunks.push(chunk);
        continue;
      }
    }

    chunks.push(chunk);
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining) chunks.push(remaining);
  return chunks.filter(Boolean);
}

export function renderTelegramPlainText(text: string): string {
  return String(text || "").trim();
}

export function escapeTelegramMarkdownV2(text: string): string {
  const value = String(text || "");

  // Split into chunks: code blocks vs non-code
  const parts = value.split(/(```[\s\S]*?```|`[^`\n]+`)/g);

  return parts
    .map((part) => {
      if (part.startsWith("```")) {
        const body = part.slice(3, part.length - 3).replace(/\\/g, "\\\\");
        return "```" + body + "```";
      }
      if (part.startsWith("`")) {
        const body = part.slice(1, part.length - 1).replace(/\\/g, "\\\\");
        return "`" + body + "`";
      }

      // 1. Identify and protect valid simple markdown pairs (*bold*, _italic_, ~strikethrough~, ||spoiler||)
      const protectedPairs: string[] = [];
      let temp = part.replace(/(\*[^\*\n]+\*|_[^_\n]+_|~[^~\n]+~|\|\|[^|\n]+\|\||\[[^\]\n]+\]\([^\)\n]+\))/g, (match) => {
        protectedPairs.push(match);
        return `\x01${protectedPairs.length - 1}\x02`;
      });

      // 2. Escape all reserved characters in the remaining text
      temp = temp.replace(/([_\\*\[\]()~`>#+\-=|{}.!])/g, "\\$1");

      // 3. Restore protected pairs
      return temp.replace(/\x01(\d+)\x02/g, (_, index) => {
        return protectedPairs[Number.parseInt(index, 10)];
      });
    })
    .join("");
}

export function escapeTelegramHtml(text: string): string {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function toTelegramEntitiesText(text: string): { text: string; entities: any[] } {
  let value = String(text || "");
  // Convert markdown headings to bold: ### Title → **Title**
  value = value
    .replace(/^###\s+(.+)$/gm, "**$1**")
    .replace(/^##\s+(.+)$/gm, "**$1**")
    .replace(/^#\s+(.+)$/gm, "**$1**");

  const entities: any[] = [];
  const output: string[] = [];

  let i = 0;
  while (i < value.length) {
    if (value.startsWith("**", i)) {
      const end = value.indexOf("**", i + 2);
      if (end > i + 2) {
        const start = output.join("").length;
        const inner = value.slice(i + 2, end);
        output.push(inner);
        entities.push({ type: "bold", offset: start, length: inner.length });
        i = end + 2;
        continue;
      }
    }

    if (value[i] === "`") {
      if (value.startsWith("```", i)) {
        const end = value.indexOf("```", i + 3);
        if (end > i + 3) {
          const start = output.join("").length;
          let inner = value.slice(i + 3, end).replace(/^\n/, "");
          let language: string | undefined;
          const languageMatch = inner.match(/^([A-Za-z0-9_+.-]{1,32})\n/);
          if (languageMatch) {
            language = languageMatch[1];
            inner = inner.slice(languageMatch[0].length);
          }
          output.push(inner);
          entities.push(language ? { type: "pre", offset: start, length: inner.length, language } : { type: "pre", offset: start, length: inner.length });
          i = end + 3;
          continue;
        }
      } else {
        const end = value.indexOf("`", i + 1);
        if (end > i + 1) {
          const start = output.join("").length;
          const inner = value.slice(i + 1, end);
          output.push(inner);
          entities.push({ type: "code", offset: start, length: inner.length });
          i = end + 1;
          continue;
        }
      }
    }

    output.push(value[i]!);
    i += 1;
  }

  return { text: output.join(""), entities };
}

export function renderTelegramEntitiesFromIR(ir: IRNode[]): { text: string; entities: any[] } {
  const entities: any[] = [];
  const outputParts: string[] = [];
  let length = 0;

  const push = (value: string) => {
    outputParts.push(value);
    length += value.length;
  };

  const pushSpans = (text: string) => {
    let i = 0;
    let buf = "";
    const flushBuf = () => { if (buf) { push(buf); buf = ""; } };
    while (i < text.length) {
      if (text.startsWith("**", i)) {
        const end = text.indexOf("**", i + 2);
        if (end > i + 2) {
          flushBuf();
          const start = length;
          const inner = text.slice(i + 2, end);
          push(inner);
          entities.push({ type: "bold", offset: start, length: inner.length });
          i = end + 2;
          continue;
        }
      }
      if (text[i] === "`") {
        const end = text.indexOf("`", i + 1);
        if (end > i) {
          flushBuf();
          const start = length;
          const inner = text.slice(i + 1, end);
          push(inner);
          entities.push({ type: "code", offset: start, length: inner.length });
          i = end + 1;
          continue;
        }
      }
      buf += text[i]!;
      i += 1;
    }
    flushBuf();
  };

  for (let idx = 0; idx < ir.length; idx++) {
    const node = ir[idx];
    const isLast = idx === ir.length - 1;

    if (node.type === "text") {
      push(node.value);
    } else if (node.type === "bold") {
      const start = length;
      push(node.value);
      entities.push({ type: "bold", offset: start, length: node.value.length });
    } else if (node.type === "heading") {
      const start = length;
      push(node.value);
      entities.push({ type: "bold", offset: start, length: node.value.length });
      if (!isLast) push("\n");
    } else if (node.type === "code_inline") {
      const start = length;
      push(node.value);
      entities.push({ type: "code", offset: start, length: node.value.length });
    } else if (node.type === "code_block") {
      const start = length;
      const blockValue = node.value + "\n";
      push(blockValue);
      entities.push(
        node.language
          ? { type: "pre", offset: start, length: blockValue.length, language: node.language }
          : { type: "pre", offset: start, length: blockValue.length },
      );
    } else if (node.type === "table") {
      const lastRowIdx = node.rows.length - 1;
      const lastColIdx = node.headers.length - 1;
      for (let rowIdx = 0; rowIdx <= lastRowIdx; rowIdx++) {
        const row = node.rows[rowIdx]!;
        for (let colIdx = 0; colIdx <= lastColIdx; colIdx++) {
          const header = node.headers[colIdx] ?? `Field ${colIdx + 1}`;
          const cell = row[colIdx] ?? "";
          const isVeryLast = rowIdx === lastRowIdx && colIdx === lastColIdx;
          const headerStart = length;
          push(header);
          entities.push({ type: "bold", offset: headerStart, length: header.length });
          push(`: ${cell}`);
          if (!isVeryLast) push("\n");
        }
        if (rowIdx < lastRowIdx) push("---\n");
      }
      if (!isLast) push("\n");
    } else if (node.type === "list") {
      if (length > 0 && !outputParts[outputParts.length - 1]?.endsWith("\n")) push("\n");
      node.items.forEach((item, idx) => {
        push(node.ordered ? `${(node.start ?? 1) + idx}. ` : `- `);
        pushSpans(item);
        if (idx < node.items.length - 1) push("\n");
      });
      if (!isLast) push("\n");
    }
  }

  return { text: outputParts.join(""), entities };
}
