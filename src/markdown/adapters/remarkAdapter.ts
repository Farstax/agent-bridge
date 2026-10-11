import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { Root, Content, PhrasingContent, TableRow, TableCell, ListItem } from "mdast";
import type { MarkdownParser, IRNode, IRListItem } from "../types.js";

/**
 * Adapter for unified + remark-parse + remark-gfm (MDAST ecosystem).
 */
export class RemarkMarkdownParser implements MarkdownParser {
  readonly id = "remark";
  readonly name = "remark-parse + remark-gfm";
  private readonly processor = unified().use(remarkParse).use(remarkGfm);

  parse(markdown: string): IRNode[] {
    if (!markdown) return [];
    const tree = this.processor.parse(markdown) as Root;
    return this.convertContentNodes(tree.children);
  }

  private convertContentNodes(nodes: Content[]): IRNode[] {
    const result: IRNode[] = [];

    for (const node of nodes) {
      switch (node.type) {
        case "heading": {
          result.push({
            type: "heading",
            level: node.depth,
            value: this.phrasingToText(node.children),
          });
          break;
        }

        case "code": {
          result.push({
            type: "code_block",
            value: node.value,
            language: node.lang ?? undefined,
          });
          break;
        }

        case "table": {
          const rows = node.children as TableRow[];
          if (rows.length === 0) break;
          const headerRow = rows[0];
          const headers = headerRow.children.map((c) => this.phrasingToText(c.children));
          const dataRows = rows.slice(1).map((row) =>
            row.children.map((c) => this.phrasingToText(c.children))
          );
          result.push({
            type: "table",
            headers,
            rows: dataRows,
          });
          break;
        }

        case "list": {
          const ordered = Boolean(node.ordered);
          const startNum = typeof node.start === "number" ? node.start : (ordered ? 1 : undefined);
          const items: (string | IRListItem)[] = [];

          for (const item of node.children as ListItem[]) {
            let itemText = "";
            let sublistNode: IRNode | undefined;

            for (const child of item.children) {
              if (child.type === "list") {
                const subConverted = this.convertContentNodes([child]);
                if (subConverted.length > 0 && subConverted[0].type === "list") {
                  sublistNode = subConverted[0];
                }
              } else if (child.type === "paragraph") {
                itemText += (itemText ? "\n\n" : "") + this.phrasingToMarkdown(child.children);
              }
            }

            items.push({
              text: itemText,
              checked: typeof item.checked === "boolean" ? item.checked : null,
              sublist: sublistNode,
            });
          }

          result.push({
            type: "list",
            items,
            ordered,
            start: startNum,
          });
          break;
        }

        case "blockquote": {
          let bText = "";
          for (const child of node.children) {
            if (child.type === "paragraph") {
              bText += (bText ? "\n" : "") + this.phrasingToText(child.children);
            }
          }
          result.push({
            type: "blockquote",
            value: bText,
          });
          break;
        }

        case "thematicBreak": {
          result.push({ type: "hr" });
          break;
        }

        case "paragraph": {
          result.push(...this.convertPhrasingNodes(node.children));
          break;
        }

        case "html": {
          result.push({ type: "text", value: node.value });
          break;
        }

        default:
          break;
      }
    }

    return result;
  }

  private convertPhrasingNodes(nodes: PhrasingContent[]): IRNode[] {
    const result: IRNode[] = [];

    for (const node of nodes) {
      switch (node.type) {
        case "text":
          result.push({ type: "text", value: node.value });
          break;

        case "strong":
          result.push({ type: "bold", value: this.phrasingToText(node.children) });
          break;

        case "emphasis":
          result.push({ type: "italic", value: this.phrasingToText(node.children) });
          break;

        case "delete":
          result.push({ type: "strikethrough", value: this.phrasingToText(node.children) });
          break;

        case "inlineCode":
          result.push({ type: "code_inline", value: node.value });
          break;

        case "link":
          result.push({
            type: "link",
            text: this.phrasingToText(node.children),
            url: node.url,
          });
          break;

        case "html":
          result.push({ type: "text", value: node.value });
          break;

        case "break":
          result.push({ type: "text", value: "\n" });
          break;

        default:
          break;
      }
    }

    return result;
  }

  
  private phrasingToMarkdown(nodes: PhrasingContent[]): string {
    let out = "";
    for (const n of nodes) {
      if (n.type === "text") out += n.value;
      else if (n.type === "inlineCode") out += "`" + n.value + "`";
      else if (n.type === "strong") out += "**" + this.phrasingToMarkdown(n.children) + "**";
      else if (n.type === "emphasis") out += "*" + this.phrasingToMarkdown(n.children) + "*";
      else if (n.type === "delete") out += "~~" + this.phrasingToMarkdown(n.children) + "~~";
      else if (n.type === "link") out += "[" + this.phrasingToMarkdown(n.children) + "](" + n.url + ")";
      else if ("children" in n && Array.isArray((n as any).children)) {
        out += this.phrasingToMarkdown((n as any).children);
      }
    }
    return out;
  }

  private phrasingToText(nodes: PhrasingContent[]): string {
    let out = "";
    for (const n of nodes) {
      if (n.type === "text") out += n.value;
      else if (n.type === "inlineCode") out += n.value;
      else if ("children" in n && Array.isArray((n as any).children)) {
        out += this.phrasingToText((n as any).children);
      }
    }
    return out;
  }
}
