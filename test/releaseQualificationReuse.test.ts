import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(fileURLToPath(new URL("../.github/workflows/release-artifact.yml", import.meta.url)), "utf8");
const marker = "          script: |\n";
const start = workflow.indexOf(marker);
const end = workflow.indexOf("\n      - name: Run repository qualification gate", start);
if (start < 0 || end < 0) throw new Error("release qualification script moved");
const script = workflow.slice(start + marker.length, end).split("\n")
  .map((line) => line.startsWith("            ") ? line.slice(12) : line).join("\n");

const mainSha = "a".repeat(40);
const headSha = "b".repeat(40);
const pr = {
  number: 123,
  merged_at: "2026-11-14T00:00:00Z",
  base: { ref: "main", repo: { full_name: "Farstax/agent-bridge" } },
  head: { sha: headSha, ref: "feature", repo: { id: 42 } },
  merge_commit_sha: mainSha,
};
const run = {
  id: 789,
  head_sha: headSha,
  head_branch: "feature",
  head_repository: { id: 42 },
  pull_requests: [], // GitHub returns this for successful real pull_request runs.
  event: "pull_request",
  status: "completed",
  conclusion: "success",
  run_attempt: 2,
};
const job = { name: "Test & Typecheck", status: "completed", conclusion: "success", run_attempt: 2 };

type Options = {
  sourceTree?: string;
  associated?: unknown[];
  runs?: unknown[];
  jobs?: unknown[];
  failLookup?: boolean;
};

async function check(options: Options = {}) {
  const outputs: Record<string, string> = {};
  const requests: number[] = [];
  const github = {
    rest: {
      repos: {
        getCommit: async ({ ref }: { ref: string }) => ({
          data: { commit: { tree: { sha: ref === mainSha ? "same-tree" : (options.sourceTree ?? "same-tree") } } },
        }),
        listPullRequestsAssociatedWithCommit: async () => ({
          data: options.associated ?? [pr],
        }),
      },
      actions: {
        listWorkflowRuns: async () => {
          if (options.failLookup) throw new Error("API unavailable");
          return { data: { workflow_runs: options.runs ?? [run] } };
        },
        listJobsForWorkflowRunAttempt: async ({ attempt_number }: { attempt_number: number }) => {
          requests.push(attempt_number);
          return { data: { jobs: options.jobs ?? [job] } };
        },
      },
    },
  };
  const core = {
    setOutput: (key: string, value: string) => { outputs[key] = value; },
    notice: () => {},
    warning: () => {},
  };
  await runInNewContext("(async () => {\n" + script + "\n})()", {
    github, core, context: { repo: { owner: "Farstax", repo: "agent-bridge" }, sha: mainSha },
  });
  return { outputs, requests };
}

describe("release artifact exact-tree PR qualification reuse", () => {
  it("reuses only a successful exact attempt, including real GitHub's empty pull_requests array", async () => {
    const { outputs, requests } = await check();
    expect(outputs).toMatchObject({
      reuse: "true",
      source_pr: "123",
      source_run_id: "789",
      source_run_attempt: "2",
      source_head_sha: headSha,
    });
    expect(requests).toEqual([2]);
  });

  it.each([
    ["tree mismatch", { sourceTree: "different-tree" }],
    ["no merged PR", { associated: [] }],
    ["ambiguous PR", { associated: [pr, pr] }],
    ["missing run", { runs: [] }],
    ["failed CI", { runs: [{ ...run, conclusion: "failure" }] }],
    ["stale successful retry", { jobs: [{ ...job, run_attempt: 1 }] }],
    ["skipped test job", { jobs: [{ ...job, conclusion: "skipped" }] }],
    ["failed test job", { jobs: [{ ...job, conclusion: "failure" }] }],
    ["wrong source branch", { runs: [{ ...run, head_branch: "other" }] }],
    ["GitHub API error", { failLookup: true }],
  ])("falls back to complete qualification on %s", async (_case, options) => {
    const { outputs } = await check(options);
    expect(outputs.reuse).toBe("false");
  });

  it("always retains the real nspawn isolation check and release-specific verification", () => {
    expect(workflow).toContain("RUN_NSPAWN_QUALIFICATION=1 npm test -- --run test/recoveryCopyIsolation.test.ts");
    expect(workflow).toContain("if: github.event_name != 'push' || steps.reuse.outputs.reuse != 'true'");
    expect(workflow).toContain("npm run qualify:local");
    expect(workflow).toContain("npm run build");
    expect(workflow).toContain("scripts/releaseManifest.mjs");
    expect(workflow).toContain("tar -xzf");
    expect(workflow).toContain("sha256sum");
  });
});
