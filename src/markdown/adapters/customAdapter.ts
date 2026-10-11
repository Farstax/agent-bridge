import { parseMarkdownToIR } from "../../markdownIR.js";
import type { MarkdownParser, IRNode } from "../types.js";

/**
 * Custom line-by-line regex parser adapter (Agent Bridge baseline).
 */
export class CustomMarkdownParser implements MarkdownParser {
  readonly id = "custom";
  readonly name = "Custom Parser (Baseline)";

  parse(input: string): IRNode[] {
    return parseMarkdownToIR(input);
  }
}
