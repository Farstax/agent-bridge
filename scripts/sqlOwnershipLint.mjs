#!/usr/bin/env node
// Advisor/conversation SQL ownership guard (Phase 4B, issue #135).
//
// advisor_calls/advisor_attempts/conversation_turns/conversation_summaries
// must only be referenced from their owning repository, the legacy baseline
// migration (which creates them), or a table reference textually inside a
// `.prepare(`/`.exec(` call whose immediately preceding, unbroken comment
// block carries an `arch-lint-allow-legacy-sql` marker.
//
// A table reference is proven to belong to a statement only if its exact
// character offset falls within that statement's own range — computed by
// tracking paren depth from the call's opening `(`, treating characters
// inside a backtick template literal as inert (so `COALESCE(...)`/subquery
// parens inside the SQL text don't confuse the count), until depth returns
// to 0. Every occurrence of an owned table name is checked independently
// (not just the first per line), and marker state is keyed by each
// statement's own start offset (not its line number), so two statements
// sharing a line — one marked, one not — are never conflated.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const OWNED_TABLES = /\b(advisor_calls|advisor_attempts|conversation_turns|conversation_summaries)\b/g;
const STATEMENT_START = /\.(prepare|exec)\(/g;
const MARKER = "arch-lint-allow-legacy-sql";
const OWNER_FILE_SUFFIXES = [
  "src/repositories/advisorRepository.ts",
  "src/repositories/conversationRepository.ts",
  "src/db/legacyBaselineMigration.ts",
  // The canonical schema contract names all durable tables by design.
  "src/db/schemaContract.ts",
];

function listFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listFiles(full));
    else if (/\.ts$/.test(entry)) out.push(full);
  }
  return out;
}

function isOwnerFile(relPath) {
  return OWNER_FILE_SUFFIXES.some((suffix) => relPath === suffix || relPath.endsWith(`/${suffix}`));
}

/**
 * Computes [startOffset, endOffset) character ranges (into the whole-file
 * string) for every `.prepare(`/`.exec(` call, by tracking paren depth from
 * the call's opening `(` and ignoring parens/backticks while inside a
 * template literal, until depth returns to 0.
 */
function findStatementRanges(content) {
  const ranges = [];
  STATEMENT_START.lastIndex = 0;
  let m;
  while ((m = STATEMENT_START.exec(content)) !== null) {
    const openParenIndex = m.index + m[0].length - 1; // index of the "(" itself
    let depth = 1;
    let inTemplate = false;
    let i = openParenIndex + 1;
    for (; i < content.length && depth > 0; i++) {
      const ch = content[i];
      if (ch === "\\" && inTemplate) {
        i++; // skip escaped char inside template
        continue;
      }
      if (ch === "`") {
        inTemplate = !inTemplate;
        continue;
      }
      if (inTemplate) continue;
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
    }
    ranges.push({ start: openParenIndex, end: i }); // end is exclusive, one past the closing ")"
  }
  return ranges;
}

function offsetToLine(content, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content[i] === "\n") line++;
  }
  return line;
}

function lineTextAt(lines, lineNumber) {
  return lines[lineNumber - 1] ?? "";
}

/**
 * A statement is marked only if: (1) it is the *only* statement starting on
 * its start line, and (2) the contiguous comment/blank-line block
 * immediately above that line contains the marker. A marker comment
 * precedes a line, not a specific call — if two statements start on the
 * same line, the marker can't be unambiguously attributed to just one of
 * them, so neither is exempted (fail closed) rather than exempting both.
 */
function statementIsMarked(lines, statementStartOffset, content, startsPerLine) {
  const startLine = offsetToLine(content, statementStartOffset);
  if ((startsPerLine.get(startLine) ?? 0) > 1) return false;
  let j = startLine - 2; // 0-indexed line just above the start line
  while (j >= 0) {
    const trimmed = lines[j].trim();
    if (trimmed.startsWith("//")) {
      if (trimmed.includes(MARKER)) return true;
      j--;
      continue;
    }
    if (trimmed === "") {
      j--;
      continue;
    }
    break;
  }
  return false;
}

function lintFile(filePath, relPath) {
  const violations = [];
  if (isOwnerFile(relPath)) return violations;
  const content = readFileSync(filePath, "utf8");
  const lines = content.split("\n");
  const statementRanges = findStatementRanges(content);
  const startsPerLine = new Map();
  for (const r of statementRanges) {
    const startLine = offsetToLine(content, r.start);
    startsPerLine.set(startLine, (startsPerLine.get(startLine) ?? 0) + 1);
  }
  const markedByStartOffset = new Map(
    statementRanges.map((r) => [r.start, statementIsMarked(lines, r.start, content, startsPerLine)]),
  );

  OWNED_TABLES.lastIndex = 0;
  let match;
  while ((match = OWNED_TABLES.exec(content)) !== null) {
    const matchOffset = match.index;
    const lineNumber = offsetToLine(content, matchOffset);
    const lineText = lineTextAt(lines, lineNumber);
    // Skip a match that's part of a comment-only mention (a pure prose
    // line, not executable SQL). A match inside a statement that itself
    // sits after a `//` on the same line is still checked normally below,
    // since the statement-range check is what actually matters.
    if (lineText.trim().startsWith("//")) continue;

    const containingStatement = statementRanges.find(
      (r) => matchOffset >= r.start && matchOffset < r.end,
    );
    if (containingStatement && markedByStartOffset.get(containingStatement.start)) {
      continue;
    }
    violations.push(`${relPath}:${lineNumber}:${lineText}`);
  }
  return violations;
}

const targetDir = process.argv[2] || "src";
const files = listFiles(targetDir);
const allViolations = [];
for (const file of files) {
  const relPath = relative(process.cwd(), file);
  allViolations.push(...lintFile(file, relPath));
}

if (allViolations.length > 0) {
  console.error(
    "arch-lint: advisor/conversation SQL must live in its owning repository " +
    "(src/repositories/advisorRepository.ts, src/repositories/conversationRepository.ts) " +
    "or be textually inside a .prepare()/.exec() call explicitly marked with " +
    "arch-lint-allow-legacy-sql immediately above",
  );
  for (const v of allViolations) console.error(v);
  process.exit(1);
}
process.exit(0);
