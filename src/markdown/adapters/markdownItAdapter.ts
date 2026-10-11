import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import type { MarkdownParser, IRNode, IRListItem } from "../types.js";

/**
 * Adapter for markdown-it (https://github.com/markdown-it/markdown-it).
 */
export class MarkdownItParser implements MarkdownParser {
  readonly id = "markdown-it";
  readonly name = "markdown-it";
  private readonly md: MarkdownIt;

  constructor() {
    this.md = new MarkdownIt({
      html: true,
      linkify: false,
      typographer: false,
    });
  }

  parse(markdown: string): IRNode[] {
    if (!markdown) return [];
    const tokens = this.md.parse(markdown, {});
    return this.convertTokens(tokens);
  }

  private convertTokens(tokens: Token[]): IRNode[] {
    const nodes: IRNode[] = [];
    let i = 0;

    while (i < tokens.length) {
      const token = tokens[i];

      if (token.type === "heading_open") {
        const level = parseInt(token.tag.slice(1), 10) || 1;
        i++;
        let headingText = "";
        if (i < tokens.length && tokens[i].type === "inline") {
          headingText = tokens[i].content;
          i++;
        }
        while (i < tokens.length && tokens[i].type !== "heading_close") {
          i++;
        }
        i++; // skip heading_close
        nodes.push({ type: "heading", level, value: headingText });
      } else if (token.type === "fence" || token.type === "code_block") {
        nodes.push({
          type: "code_block",
          value: token.content.replace(/\n$/, ""),
          language: token.info ? token.info.trim().split(/\s+/)[0] : undefined,
        });
        i++;
      } else if (token.type === "paragraph_open") {
        i++;
        if (i < tokens.length && tokens[i].type === "inline") {
          nodes.push(...this.convertInline(tokens[i]));
          i++;
        }
        while (i < tokens.length && tokens[i].type !== "paragraph_close") {
          i++;
        }
        i++; // skip paragraph_close
      } else if (token.type === "ordered_list_open" || token.type === "bullet_list_open") {
        const [listNode, nextIdx] = this.parseList(tokens, i);
        nodes.push(listNode);
        i = nextIdx;
      } else if (token.type === "table_open") {
        const [tableNode, nextIdx] = this.parseTable(tokens, i);
        nodes.push(tableNode);
        i = nextIdx;
      } else if (token.type === "blockquote_open") {
        i++;
        let bText = "";
        while (i < tokens.length && tokens[i].type !== "blockquote_close") {
          if (tokens[i].type === "inline") {
            bText += (bText ? "\n" : "") + tokens[i].content;
          }
          i++;
        }
        i++; // skip blockquote_close
        nodes.push({ type: "blockquote", value: bText });
      } else if (token.type === "hr") {
        nodes.push({ type: "hr" });
        i++;
      } else if (token.type === "html_block") {
        nodes.push({ type: "text", value: token.content });
        i++;
      } else {
        i++;
      }
    }

    return nodes;
  }

  private parseList(tokens: Token[], startIndex: number): [IRNode, number] {
    const rootToken = tokens[startIndex];
    const ordered = rootToken.type === "ordered_list_open";
    const startAttr = rootToken.attrs?.find((a) => a[0] === "start");
    const startNum = startAttr ? parseInt(startAttr[1], 10) : (ordered ? 1 : undefined);
    const closeType = ordered ? "ordered_list_close" : "bullet_list_close";

    const items: (string | IRListItem)[] = [];
    let i = startIndex + 1;

    while (i < tokens.length && tokens[i].type !== closeType) {
      if (tokens[i].type === "list_item_open") {
        i++;
        let itemText = "";
        let sublistNode: IRNode | undefined;
        let checked: boolean | null = null;

        while (i < tokens.length && tokens[i].type !== "list_item_close") {
          const t = tokens[i];
          if (t.type === "inline") {
            let content = t.content;
            if (/^\[([ xX])\]\s+/.test(content)) {
              checked = content.startsWith("[x]") || content.startsWith("[X]");
              content = content.replace(/^\[([ xX])\]\s+/, "");
            }
            itemText += (itemText ? "\n" : "") + content;
            i++;
          } else if (t.type === "ordered_list_open" || t.type === "bullet_list_open") {
            const [sub, nextIdx] = this.parseList(tokens, i);
            sublistNode = sub;
            i = nextIdx;
          } else {
            i++;
          }
        }

        items.push({
          text: itemText,
          checked,
          sublist: sublistNode,
        });
      }
      i++;
    }

    return [
      {
        type: "list",
        items,
        ordered,
        start: startNum,
      },
      i + 1,
    ];
  }

  private parseTable(tokens: Token[], startIndex: number): [IRNode, number] {
    let inThead = false;
    let inTbody = false;
    const headers: string[] = [];
    const rows: string[][] = [];
    let currentRow: string[] = [];
    let i = startIndex + 1;

    while (i < tokens.length && tokens[i].type !== "table_close") {
      const t = tokens[i];
      if (t.type === "thead_open") inThead = true;
      else if (t.type === "thead_close") inThead = false;
      else if (t.type === "tbody_open") inTbody = true;
      else if (t.type === "tbody_close") inTbody = false;
      else if (t.type === "tr_open") currentRow = [];
      else if (t.type === "tr_close") {
        if (inTbody && currentRow.length > 0) rows.push(currentRow);
      } else if (t.type === "inline") {
        if (inThead) headers.push(t.content);
        else if (inTbody) currentRow.push(t.content);
      }
      i++;
    }

    return [
      {
        type: "table",
        headers,
        rows,
      },
      i + 1,
    ];
  }

  private convertInline(inlineToken: Token): IRNode[] {
    const res: IRNode[] = [];
    if (!inlineToken.children || inlineToken.children.length === 0) {
      if (inlineToken.content) res.push({ type: "text", value: inlineToken.content });
      return res;
    }

    const children = inlineToken.children;
    let idx = 0;

    while (idx < children.length) {
      const c = children[idx];
      switch (c.type) {
        case "text":
          res.push({ type: "text", value: c.content });
          idx++;
          break;

        case "strong_open": {
          idx++;
          let text = "";
          while (idx < children.length && children[idx].type !== "strong_close") {
            text += children[idx].content;
            idx++;
          }
          res.push({ type: "bold", value: text });
          if (idx < children.length) idx++;
          break;
        }

        case "em_open": {
          idx++;
          let text = "";
          while (idx < children.length && children[idx].type !== "em_close") {
            text += children[idx].content;
            idx++;
          }
          res.push({ type: "italic", value: text });
          if (idx < children.length) idx++;
          break;
        }

        case "s_open": {
          idx++;
          let text = "";
          while (idx < children.length && children[idx].type !== "s_close") {
            text += children[idx].content;
            idx++;
          }
          res.push({ type: "strikethrough", value: text });
          if (idx < children.length) idx++;
          break;
        }

        case "code_inline":
          res.push({ type: "code_inline", value: c.content });
          idx++;
          break;

        case "link_open": {
          const href = c.attrs?.find((a) => a[0] === "href")?.[1] || "";
          idx++;
          let text = "";
          while (idx < children.length && children[idx].type !== "link_close") {
            text += children[idx].content;
            idx++;
          }
          res.push({ type: "link", text, url: href });
          if (idx < children.length) idx++;
          break;
        }

        case "html_inline":
          res.push({ type: "text", value: c.content });
          idx++;
          break;

        case "softbreak":
        case "hardbreak":
          res.push({ type: "text", value: "\n" });
          idx++;
          break;

        default:
          if (c.content) res.push({ type: "text", value: c.content });
          idx++;
          break;
      }
    }

    return res;
  }
}
