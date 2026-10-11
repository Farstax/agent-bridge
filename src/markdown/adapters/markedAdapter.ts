import { marked, type Token, type Tokens } from "marked";
import type { MarkdownParser, IRNode, IRListItem } from "../types.js";

/**
 * Adapter for the Marked library (https://github.com/markedjs/marked).
 */
export class MarkedMarkdownParser implements MarkdownParser {
  readonly id = "marked";
  readonly name = "Marked";

  parse(markdown: string): IRNode[] {
    if (!markdown) return [];
    // marked.lexer tokenizes block structures with nested inlines
    const tokens = marked.lexer(markdown);
    return this.convertBlockTokens(tokens);
  }

  private convertBlockTokens(tokens: Token[]): IRNode[] {
    const nodes: IRNode[] = [];

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      switch (token.type) {
        case "heading": {
          nodes.push({
            type: "heading",
            level: token.depth,
            value: token.text,
          });
          break;
        }

        case "code": {
          nodes.push({
            type: "code_block",
            value: token.text,
            language: token.lang ? token.lang.split(/\s+/)[0] : undefined,
          });
          break;
        }

        case "table": {
          const headers = (token as Tokens.Table).header.map((cell: Tokens.TableCell) => cell.text);
          const rows = (token as Tokens.Table).rows.map((row: Tokens.TableCell[]) => row.map((cell: Tokens.TableCell) => cell.text));
          nodes.push({
            type: "table",
            headers,
            rows,
          });
          break;
        }

        case "list": {
          const listToken = token as Tokens.List;
          const items: (string | IRListItem)[] = [];

          for (const item of listToken.items) {
            let itemText = "";
            let sublistNode: IRNode | undefined;

            if (item.tokens && item.tokens.length > 0) {
              const textParts: string[] = [];
              for (const subToken of item.tokens) {
                if (subToken.type === "list") {
                  const subConverted = this.convertBlockTokens([subToken]);
                  if (subConverted.length > 0 && subConverted[0].type === "list") {
                    sublistNode = subConverted[0];
                  }
                } else if (subToken.type === "text" || subToken.type === "paragraph") {
                  textParts.push(subToken.text);
                } else if ("text" in subToken && typeof (subToken as any).text === "string") {
                  textParts.push((subToken as any).text);
                }
              }
              itemText = textParts.join("\n\n");
            } else {
              itemText = item.text;
            }

            const itemObj: IRListItem = {
              text: itemText || item.text,
              checked: item.task ? Boolean(item.checked) : null,
              sublist: sublistNode,
            };
            items.push(itemObj);
          }

          const startNum = typeof listToken.start === "number" && !isNaN(listToken.start)
            ? listToken.start
            : 1;

          nodes.push({
            type: "list",
            items,
            ordered: Boolean(listToken.ordered),
            start: startNum,
          });
          break;
        }

        case "blockquote": {
          nodes.push({
            type: "blockquote",
            value: token.text,
          });
          break;
        }

        case "hr": {
          nodes.push({ type: "hr" });
          break;
        }

        case "paragraph": {
          const inlines = this.convertInlineTokens(token.tokens);
          if (inlines.length > 0) {
            nodes.push(...inlines);
          } else {
            nodes.push({ type: "text", value: token.text });
          }
          break;
        }

        case "html": {
          nodes.push({ type: "text", value: token.raw });
          break;
        }

        case "space": {
          // If between paragraphs or blocks, add newline separation if needed
          break;
        }

        default: {
          if ("tokens" in token && Array.isArray((token as any).tokens)) {
            nodes.push(...this.convertInlineTokens((token as any).tokens));
          } else if ("text" in token && typeof (token as any).text === "string") {
            nodes.push({ type: "text", value: (token as any).text });
          }
          break;
        }
      }
    }

    return nodes;
  }

  private convertInlineTokens(tokens?: Token[]): IRNode[] {
    if (!tokens || tokens.length === 0) return [];
    const nodes: IRNode[] = [];

    for (const token of tokens) {
      switch (token.type) {
        case "text": {
          if (token.tokens && token.tokens.length > 0) {
            nodes.push(...this.convertInlineTokens(token.tokens));
          } else {
            nodes.push({ type: "text", value: token.text });
          }
          break;
        }

        case "strong": {
          nodes.push({ type: "bold", value: token.text });
          break;
        }

        case "em": {
          nodes.push({ type: "italic", value: token.text });
          break;
        }

        case "del": {
          nodes.push({ type: "strikethrough", value: token.text });
          break;
        }

        case "codespan": {
          nodes.push({ type: "code_inline", value: token.text });
          break;
        }

        case "link": {
          nodes.push({
            type: "link",
            text: token.text,
            url: token.href,
          });
          break;
        }

        case "html": {
          nodes.push({ type: "text", value: token.raw });
          break;
        }

        case "escape": {
          nodes.push({ type: "text", value: token.text });
          break;
        }

        default: {
          if ("text" in token && typeof (token as any).text === "string") {
            nodes.push({ type: "text", value: (token as any).text });
          }
          break;
        }
      }
    }

    return nodes;
  }
}
