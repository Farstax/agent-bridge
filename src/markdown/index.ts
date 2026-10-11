export * from "./renderers.js";
export * from "./types.js";
export * from "./adapters/customAdapter.js";
export * from "./adapters/markedAdapter.js";
export * from "./adapters/markdownItAdapter.js";
export * from "./adapters/remarkAdapter.js";

import { CustomMarkdownParser } from "./adapters/customAdapter.js";
import { MarkedMarkdownParser } from "./adapters/markedAdapter.js";
import { MarkdownItParser } from "./adapters/markdownItAdapter.js";
import { RemarkMarkdownParser } from "./adapters/remarkAdapter.js";
import type { MarkdownParser } from "./types.js";

export const CANDIDATE_PARSERS: Record<string, MarkdownParser> = {
  custom: new CustomMarkdownParser(),
  marked: new MarkedMarkdownParser(),
  "markdown-it": new MarkdownItParser(),
  remark: new RemarkMarkdownParser(),
};
