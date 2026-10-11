/**
 * Core Markdown IR and Parser Contract
 *
 * Provides a parser-neutral typed document representation so that surface
 * renderers (Telegram HTML, Telegram Rich HTML, Discord) remain decoupled
 * from the specific parsing library.
 */

export interface IRListItem {
  text: string;
  sublist?: IRNode;
  checked?: boolean | null;
}

export type IRNode =
  | { type: "text"; value: string }
  | { type: "bold"; value: string }
  | { type: "italic"; value: string }
  | { type: "strikethrough"; value: string }
  | { type: "code_inline"; value: string }
  | { type: "code_block"; value: string; language?: string }
  | { type: "heading"; level: number; value: string }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "list"; items: (string | IRListItem)[]; ordered?: boolean; start?: number }
  | { type: "blockquote"; value: string }
  | { type: "hr" }
  | { type: "link"; text: string; url: string };

export interface MarkdownParser {
  readonly id: string;
  readonly name: string;
  parse(markdown: string): IRNode[];
}

export interface MarkerTable {
  text: (text: string) => string;
  bold: (text: string) => string;
  code_inline: (text: string) => string;
  code_block: (text: string, language?: string) => string;
  heading: (text: string, level: number) => string;
  table: (headers: string[], rows: string[][]) => string;
  list: (items: (string | IRListItem)[], ordered?: boolean, start?: number) => string;
  link: (text: string, url: string) => string;
  italic?: (text: string) => string;
  strikethrough?: (text: string) => string;
  blockquote?: (text: string) => string;
  hr?: () => string;
}
