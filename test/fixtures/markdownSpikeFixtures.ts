export interface MarkdownFixture {
  id: string;
  category: number | string;
  categoryName: string;
  title: string;
  input: string;
  description: string;
}

export const MARKDOWN_SPIKE_FIXTURES: MarkdownFixture[] = [
  // 1. Consecutive ordered lists and blank-line-separated ordered lists
  {
    id: "cat1-consecutive-blank-lines",
    category: 1,
    categoryName: "consecutive-and-blank-line-lists",
    title: "Ordered list with blank lines between items",
    input: "1. First task\n\n1. Second task\n\n1. Third task",
    description: "Standard Markdown loose ordered list where items are separated by blank lines; must render as single list with 1, 2, 3.",
  },
  {
    id: "cat1-consecutive-tight",
    category: 1,
    categoryName: "consecutive-and-blank-line-lists",
    title: "Ordered list tight without blank lines",
    input: "1. Step one\n2. Step two\n3. Step three",
    description: "Tight ordered list without blank lines; must render as single list with 1, 2, 3.",
  },

  // 2. Non-1 starting numbers, nested lists and mixed ordered/unordered lists
  {
    id: "cat2-non-one-start",
    category: 2,
    categoryName: "non-1-start-nested-mixed",
    title: "Ordered list starting at 5",
    input: "5. Fifth item\n6. Sixth item\n7. Seventh item",
    description: "Ordered list starting at non-1 offset; start number 5 must be preserved.",
  },
  {
    id: "cat2-nested-unordered-in-ordered",
    category: 2,
    categoryName: "non-1-start-nested-mixed",
    title: "Nested unordered list inside ordered list",
    input: "1. Parent step\n   - Sub bullet A\n   - Sub bullet B\n2. Next parent step",
    description: "Nested bullet list under an ordered list item.",
  },
  {
    id: "cat2-nested-ordered-in-unordered",
    category: 2,
    categoryName: "non-1-start-nested-mixed",
    title: "Nested ordered list inside unordered list",
    input: "- Main topic\n  1. First detail\n  2. Second detail\n- Other topic",
    description: "Nested numbered list under an unordered list item.",
  },

  // 3. Multiline list items and paragraphs within list items
  {
    id: "cat3-multiline-paragraphs-in-item",
    category: 3,
    categoryName: "multiline-and-paragraphs-in-list",
    title: "List item containing multiple paragraphs",
    input: "1. Initial instructions\n\n   Additional context paragraph for the first instruction.\n\n2. Second instruction",
    description: "List item with an indented continuation paragraph.",
  },
  {
    id: "cat3-code-inside-list-item",
    category: 3,
    categoryName: "multiline-and-paragraphs-in-list",
    title: "List item containing a fenced code block",
    input: "1. Run the command:\n   ```bash\n   npm test\n   ```\n2. Check results",
    description: "List item with embedded code block.",
  },

  // 4. Bold, italics, strikethrough, code, links and escaped punctuation
  {
    id: "cat4-inline-formatting-combinations",
    category: 4,
    categoryName: "inline-formatting-and-escaping",
    title: "Rich inline combinations and escapes",
    input: "This has **bold**, *italic*, ~~strikethrough~~, `code_inline`, and [Agent Docs](https://example.com/docs). Escaped: \*not italic\* and \[not link\].",
    description: "All standard CommonMark inline spans and escaped punctuation.",
  },
  {
    id: "cat4-nested-inline",
    category: 4,
    categoryName: "inline-formatting-and-escaping",
    title: "Nested inline spans",
    input: "Here is **bold with *italic* inside** and [`code in link`](https://example.com).",
    description: "Nested inline formatting spans.",
  },

  // 5. Fenced code blocks containing Markdown-like text
  {
    id: "cat5-fenced-code-with-markdown",
    category: 5,
    categoryName: "fenced-code-with-markdown",
    title: "Fenced code block containing Markdown syntax and tags",
    input: "```markdown\n# Not a heading\n**Not bold**\n<tag>Not HTML</tag>\n1. Not a list\n```",
    description: "Fenced code block containing characters that must not be parsed as markdown or unescaped HTML.",
  },
  {
    id: "cat5-code-language-tag",
    category: 5,
    categoryName: "fenced-code-with-markdown",
    title: "Code block with language specifier",
    input: "```typescript\ninterface User { id: string; }\n```",
    description: "Code block with language identifier.",
  },

  // 6. Tables, including inline formatting inside cells
  {
    id: "cat6-table-with-formatting",
    category: 6,
    categoryName: "tables-and-cell-formatting",
    title: "Table with bold, code, and links in cells",
    input: "| Service | Status | Link |\n| :--- | :---: | ---: |\n| **Bridge** | `active` | [Check](https://status.local) |\n| **Advisor** | `idle` | [Logs](https://logs.local) |",
    description: "GFM table with alignment markers and rich cell contents.",
  },

  // 7. Headings, blockquotes and horizontal rules
  {
    id: "cat7-headings-quotes-hr",
    category: 7,
    categoryName: "headings-quotes-hr",
    title: "Headings levels 1-3, blockquote, and hr",
    input: "# Heading 1\n## Heading 2\n### Heading 3\n\n> Important advisory note\n\n---",
    description: "Standard structural block elements.",
  },

  // 8. Task lists and common GFM features
  {
    id: "cat8-task-lists",
    category: 8,
    categoryName: "task-lists-gfm",
    title: "GFM task list items",
    input: "- [ ] Pending audit\n- [x] Completed verification\n- [ ] Follow-up task",
    description: "GFM checkboxes in unordered lists.",
  },

  // 9. Raw HTML, unsafe links, malformed input and Unicode
  {
    id: "cat9-security-html-links-unicode",
    category: 9,
    categoryName: "security-html-links-unicode",
    title: "Raw HTML injection, javascript: links, emojis, and Unicode",
    input: "Normal text <script>alert(\"xss\")</script> & <div class=\"test\">bad</div>.\nUnsafe link: [Click Me](javascript:stealTokens()).\nUnicode: 🚀 Deployment completed for 日本語 / العربية.",
    description: "Potential XSS, unsafe protocols, entities, and multi-byte UTF-8 characters.",
  },

  // 10. Long responses crossing Telegram chunk boundaries
  {
    id: "cat10-long-response-chunking",
    category: 10,
    categoryName: "long-response-chunking",
    title: "Long response (>4000 chars) with multiple blocks",
    input: [
      "### Comprehensive System Audit",
      "",
      "The following system checks were conducted across all subsystem layers to ensure stability and compliance:",
      "",
      "1. **Core Service Lifecycle**: Systemd verified active state for `agent-bridge.service`. PID tracking verified with no unexpected restarts or memory pressure.",
      "",
      "2. **Database Integrity & Migrations**: Checked SQLite WAL database `bridge.db`. Schema version 10 verified. All foreign key constraints verified with `PRAGMA foreign_key_check` returning zero anomalies.",
      "",
      "3. **Inward ACP Providers**: Evaluated Claude, Codex, Agy, and Grok. All 4 providers completed model-mediated qualification probes within tolerance limits.",
      "",
      "4. **Outward Surface Routing**: Telegram webhook/polling daemon active. Discord gateway session active with heartbeats acknowledged at 41.25s intervals.",
      "",
      "5. **Advisor Multi-Turn Chain**: Verified isolated advisory fallback chains with bounded token budgets and strict secret redaction.",
      "",
      "```json",
      JSON.stringify({
        status: "healthy",
        uptime_seconds: 86400,
        subsystems: [
          { name: "sqlite", latency_ms: 1.2 },
          { name: "acp_hub", connected_clients: 4 },
          { name: "telegram", pending_updates: 0 },
          { name: "discord", ping_ms: 22 }
        ],
        audit_verdict: "PASS_WITHOUT_RESERVATIONS"
      }, null, 2),
      "```",
      "",
      "Additional commentary on infrastructure resilience:",
      "A".repeat(2500),
      "",
      "End of audit report."
    ].join("\n"),
    description: "Response length exceeding Telegram single-message boundary (4096 chars).",
  },

  // 11. Markdown containing multiple distinct lists separated by paragraphs or headings
  {
    id: "cat11-multiple-distinct-lists",
    category: 11,
    categoryName: "multiple-distinct-lists",
    title: "Multiple distinct lists separated by headings and paragraphs",
    input: "### Morning Routine\n1. Check alerts\n2. Review pending jobs\n\nIntermediate status is operational.\n\n### Evening Routine\n1. Archive logs\n2. Verify backup",
    description: "Two distinct lists separated by headings and paragraphs; both lists must start at 1 independently.",
  },

  // 12. Partial/malformed Markdown in streaming previews
  {
    id: "cat12-streaming-partial-markdown",
    category: 12,
    categoryName: "streaming-partial-markdown",
    title: "Partial or unclosed Markdown in streaming preview",
    input: "Starting task...\n\n```typescript\nfunction test() {\n  console.log(\"in progress",
    description: "Unclosed code fence representing in-flight streaming chunk.",
  },

  // Real-world 5-step qualification response
  {
    id: "real-world-five-step-qualification",
    category: "real-world",
    categoryName: "real-world-qualification",
    title: "Five-step post-rollout qualification response",
    input: [
      "### Rollout Verification Report",
      "",
      "1. **Systemd Services**: Verified `agent-bridge.service` is active and running (PID 3446). Memory usage is stable at 68MB.",
      "",
      "2. **Database Integrity**: Confirmed schema version 10 with SQLite WAL mode enabled. 0 corrupted pages detected.",
      "",
      "3. **Inward ACP Providers**: All 4 providers (Claude, Codex, Agy, Grok) healthy and qualified under current runtime contracts.",
      "",
      "4. **Surface Channels**: Telegram polling connected; Discord gateway in state `READY` with zero pending updates.",
      "",
      "5. **External Connectivity**: Health checks passing with 0 errors across 45ms median roundtrip latency."
    ].join("\n"),
    description: "Canonical 5-step qualification report demonstrating the blank-line list numbering bug in current parser.",
  },
];
