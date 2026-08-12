// Deterministic fixture for docs/research/issue-347-runtime-simplification.md.
// This is a research benchmark, not a production retrieval implementation.

const turns = [];
const facts = new Map([
  [8, "Decision: use the companion runtime for Telegram and keep the Engineering Worker separate."],
  [24, "Decision: deploy from branch agent/old-name after CI."],
  [62, "Correction: branch agent/old-name was superseded; use branch agent/new-name."],
  [101, "Decision: the release pin is release-2026.08.09-1 while the fleet upgrade is reviewed."],
  [148, "Correction: release pin is now release-2026.08.11-3 after guarded rollout."],
  [176, "Decision: preserve human merge approval and exact-head CI."],
  [214, "Open state: replacement workspace may be needed after a failed deployment."],
]);

for (let id = 1; id <= 240; id += 1) {
  turns.push({
    id,
    text: facts.get(id)
      ?? `Routine discussion turn ${id}: inspect the current repository, provider session, test output, and next action for this bounded work.`,
  });
}

const summary = [
  "Current objective: evaluate the smaller runtime model.",
  "Durable facts:",
  "- use Agent Bridge for conversation, Runs, isolation, fencing, CI evidence, and human merge gates.",
  "- current branch is agent/new-name.",
  "- current release pin is release-2026.08.11-3.",
  "- human merge approval and exact-head CI remain required.",
  "Open state:",
  "- replacement workspace may be needed after a failed deployment.",
].join("\n");

const queries = [
  ["current branch", "agent/new-name"],
  ["release pin", "release-2026.08.11-3"],
  ["merge approval", "human merge approval"],
  ["replacement workspace", "replacement workspace"],
];

function queryTerms(query) {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

function matches(turn, query) {
  const text = turn.text.toLowerCase();
  return queryTerms(query).some((term) => text.includes(term));
}

function scopedSearch(query, expanded = false) {
  const effectiveQuery = expanded && query === "current branch" ? "branch" : query;
  return turns.filter((turn) => matches(turn, effectiveQuery)).sort((a, b) => b.id - a.id).slice(0, 3);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function p95(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.95)];
}

function measure(fn) {
  const samples = [];
  for (let i = 0; i < 1_000; i += 1) {
    const start = process.hrtime.bigint();
    fn();
    samples.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  return { medianMs: median(samples), p95Ms: p95(samples) };
}

function averageSearchChars(expanded) {
  return queries.reduce(
    (total, [query]) => total + scopedSearch(query, expanded).map((turn) => turn.text).join("\n").length,
    0,
  ) / queries.length;
}

const recent = turns.slice(-20).map((turn) => turn.text).join("\n");
const recentSearch = () => queries.map(([query]) => scopedSearch(query, true));
const cases = queries.map(([query, expected]) => ({
  query,
  recent20: recent.toLowerCase().includes(expected.toLowerCase()),
  summaryRecent: summary.toLowerCase().includes(expected.toLowerCase()),
  naiveSearch: scopedSearch(query).some((turn) => turn.text.includes(expected)),
  expandedSearch: scopedSearch(query, true).some((turn) => turn.text.includes(expected)),
  latestMatch: scopedSearch(query, true)[0]?.text ?? null,
}));

console.log(JSON.stringify({
  turnCount: turns.length,
  cases,
  tokenEstimate: {
    recent20: Math.ceil(recent.length / 4),
    summaryRecent: Math.ceil((summary.length + recent.length) / 4),
    recentSearchNaiveApprox: Math.ceil((recent.length + averageSearchChars(false)) / 4),
    recentSearchExpandedApprox: Math.ceil((recent.length + averageSearchChars(true)) / 4),
  },
  measured: {
    recent20: measure(() => recent.length),
    summaryRecent: measure(() => summary.length + recent.length),
    recentSearchExpanded: measure(recentSearch),
  },
}, null, 2));
