import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdvisorEvidenceToolBroker } from "../src/advisorEvidenceTools.js";
import { AdvisorService } from "../src/advisorService.js";
import type { AdvisorConfig } from "../src/advisorTypes.js";
import { openDb } from "../src/db.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "advisor-investigation-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function config(overrides: Partial<AdvisorConfig> = {}): AdvisorConfig {
  return {
    enabled: true,
    mode: "manual",
    chain: [{ provider: "claude", model: "claude-fable-5" }],
    maxCallsPerTurn: 2,
    maxCallsPerTask: 2,
    timeoutMs: 5_000,
    contextMaxChars: 20_000,
    ...overrides,
  };
}

function debugOutput(evidenceId: string | undefined, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    verdict: "retry",
    advice_md: "Apply the missing guard described by the evidence.",
    risks: ["Preserve existing behavior"],
    suggested_next_steps: ["Change only the guarded branch"],
    verification_steps: ["Run the focused test"],
    evidence_ids: evidenceId ? [evidenceId] : [],
    evidence_basis: evidenceId ? [{ claim: "The guard is required", evidence_ids: [evidenceId] }] : [],
    assumptions: [],
    unresolved_conflicts: [],
    confidence: "medium",
    ...overrides,
  });
}

describe("AdvisorService read-only debug investigation", () => {
  it("uses two physical model turns and one logical task budget", async () => {
    const dir = tempDir();
    const db = openDb(join(dir, "bridge.sqlite"));
    const runCli = vi.fn().mockImplementation(async (_command: string, args: string[]) => {
      if (runCli.mock.calls.length === 1) {
        return JSON.stringify({
          hypothesis: "The implementation missed the current plan constraint",
          tool_requests: [{ tool: "evidence.plan" }],
          missing_evidence: [],
        });
      }
      const evidenceId = args.join(" ").match(/ev_[a-f0-9]{16}/)?.[0];
      return debugOutput(evidenceId);
    });
    const service = new AdvisorService({
      db,
      config: config({ maxCallsPerTurn: 1, maxCallsPerTask: 1 }),
      bots: { claude: { command: "claude", modelPreference: null } },
      runCli,
    });
    const evidenceTools = new AdvisorEvidenceToolBroker({
      repoPath: dir,
      evidence: { plan: "Add the missing guard and focused test." },
    });

    try {
      const result = await service.requestTrusted({
        origin: "manual",
        scopeKey: "manual:work-item:1",
        taskKey: "work-item:1",
        mode: "debug",
        task: "Diagnose the blocked attempt",
        activeProvider: "codex",
        activeModel: null,
        cwd: dir,
        evidence: { attemptSummary: "Parser rejects the new state." },
        evidenceTools,
      });

      expect(result).toMatchObject({ verdict: "retry", confidence: "medium" });
      expect(result.evidenceIds).toHaveLength(1);
      expect(result.evidenceBasis).toHaveLength(1);
      expect(runCli).toHaveBeenCalledTimes(2);
      const attempts = db.getAdvisorAttempts(result.requestId);
      expect(attempts).toHaveLength(2);
      expect(attempts.map((attempt) => attempt.ordinal)).toEqual([1, 2]);

      await expect(service.requestTrusted({
        origin: "manual",
        scopeKey: "manual:work-item:1",
        taskKey: "work-item:1",
        mode: "debug",
        task: "Try to spend the same logical task budget again",
        activeProvider: "codex",
        activeModel: null,
        cwd: dir,
        evidenceTools: new AdvisorEvidenceToolBroker({ repoPath: dir, evidence: { plan: "same" } }),
      })).rejects.toThrow(/budget exhausted/i);
    } finally {
      db.close();
    }
  });

  it("downgrades high confidence when requested evidence is unavailable", async () => {
    const dir = tempDir();
    const db = openDb(join(dir, "bridge.sqlite"));
    const runCli = vi.fn().mockImplementation(async (_command: string, args: string[]) => {
      if (runCli.mock.calls.length === 1) {
        return JSON.stringify({ hypothesis: "Need test output", tool_requests: [{ tool: "evidence.test_failures" }], missing_evidence: [] });
      }
      const evidenceId = args.join(" ").match(/ev_[a-f0-9]{16}/)?.[0];
      return debugOutput(evidenceId, {
        verdict: "insufficient_evidence",
        advice_md: "The test evidence was unavailable.",
        risks: [],
        suggested_next_steps: ["Collect the failing test output"],
        verification_steps: [],
        evidence_basis: evidenceId ? [{ claim: "The requested test evidence is unavailable", evidence_ids: [evidenceId] }] : [],
        confidence: "high",
      });
    });
    const service = new AdvisorService({ db, config: config(), bots: { claude: { command: "claude", modelPreference: null } }, runCli });

    try {
      const result = await service.requestTrusted({
        origin: "manual",
        scopeKey: "manual:work-item:2",
        taskKey: "work-item:2",
        mode: "debug",
        task: "Diagnose missing evidence",
        activeProvider: "codex",
        activeModel: null,
        cwd: dir,
        evidenceTools: new AdvisorEvidenceToolBroker({ repoPath: dir }),
      });
      expect(result.confidence).toBe("medium");
      expect(result.verdict).toBe("insufficient_evidence");
      expect(result.evidenceIds).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("downgrades high confidence when the selector declares missing evidence", async () => {
    const dir = tempDir();
    const db = openDb(join(dir, "bridge.sqlite"));
    const runCli = vi.fn().mockImplementation(async (_command: string, args: string[]) => {
      if (runCli.mock.calls.length === 1) {
        return JSON.stringify({
          hypothesis: "The plan may omit generated output",
          tool_requests: [{ tool: "evidence.plan" }],
          missing_evidence: ["Current generated schema output"],
        });
      }
      const evidenceId = args.join(" ").match(/ev_[a-f0-9]{16}/)?.[0];
      return debugOutput(evidenceId, { confidence: "high" });
    });
    const service = new AdvisorService({ db, config: config(), bots: { claude: { command: "claude", modelPreference: null } }, runCli });

    try {
      const result = await service.requestTrusted({
        origin: "manual",
        scopeKey: "manual:work-item:missing",
        taskKey: "work-item:missing",
        mode: "debug",
        task: "Diagnose incomplete context",
        activeProvider: "codex",
        activeModel: null,
        cwd: dir,
        evidenceTools: new AdvisorEvidenceToolBroker({ repoPath: dir, evidence: { plan: "Inspect generated output" } }),
      });
      expect(result.confidence).toBe("medium");
    } finally {
      db.close();
    }
  });

  it("rejects final advice whose evidence is not attached to a structured claim", async () => {
    const dir = tempDir();
    const db = openDb(join(dir, "bridge.sqlite"));
    const runCli = vi.fn().mockImplementation(async (_command: string, args: string[]) => {
      if (runCli.mock.calls.length === 1) {
        return JSON.stringify({ hypothesis: "Need plan", tool_requests: [{ tool: "evidence.plan" }], missing_evidence: [] });
      }
      const evidenceId = args.join(" ").match(/ev_[a-f0-9]{16}/)?.[0];
      return debugOutput(evidenceId, { evidence_basis: [] });
    });
    const service = new AdvisorService({ db, config: config(), bots: { claude: { command: "claude", modelPreference: null } }, runCli });

    try {
      await expect(service.requestTrusted({
        origin: "manual",
        scopeKey: "manual:work-item:uncited",
        taskKey: "work-item:uncited",
        mode: "debug",
        task: "Reject uncited advice",
        activeProvider: "codex",
        activeModel: null,
        cwd: dir,
        evidenceTools: new AdvisorEvidenceToolBroker({ repoPath: dir, evidence: { plan: "Plan" } }),
      })).rejects.toThrow(/evidence_basis is required/i);
    } finally {
      db.close();
    }
  });

  it("records a malformed model-selected tool request as a failed provider attempt", async () => {
    const dir = tempDir();
    const db = openDb(join(dir, "bridge.sqlite"));
    const runCli = vi.fn().mockResolvedValue(JSON.stringify({
      hypothesis: "Use a shell",
      tool_requests: [{ tool: "shell", command: "cat /etc/passwd" }],
      missing_evidence: [],
    }));
    const service = new AdvisorService({ db, config: config(), bots: { claude: { command: "claude", modelPreference: null } }, runCli });

    try {
      await expect(service.requestTrusted({
        origin: "manual",
        scopeKey: "manual:work-item:3",
        taskKey: "work-item:3",
        mode: "debug",
        task: "Reject unsupported evidence tools",
        activeProvider: "codex",
        activeModel: null,
        cwd: dir,
        evidenceTools: new AdvisorEvidenceToolBroker({ repoPath: dir }),
      })).rejects.toThrow(/invalid advisor tool selection/i);

      const attempts = db.raw.prepare("SELECT status, error_kind FROM advisor_attempts ORDER BY id").all() as Array<{ status: string; error_kind: string }>;
      expect(attempts).toEqual([{ status: "failed", error_kind: "invalid_output" }]);
    } finally {
      db.close();
    }
  });

  it("fails explicitly when the configured provider cannot run the structured investigation", async () => {
    const dir = tempDir();
    const db = openDb(join(dir, "bridge.sqlite"));
    const service = new AdvisorService({ db, config: config(), bots: {}, runCli: vi.fn() });

    try {
      await expect(service.requestTrusted({
        origin: "manual",
        scopeKey: "manual:work-item:unsupported",
        taskKey: "work-item:unsupported",
        mode: "debug",
        task: "Use unavailable provider",
        activeProvider: "codex",
        activeModel: null,
        cwd: dir,
        evidenceTools: new AdvisorEvidenceToolBroker({ repoPath: dir }),
      })).rejects.toThrow(/provider unavailable/i);
      const attempts = db.raw.prepare("SELECT status FROM advisor_attempts ORDER BY id").all() as Array<{ status: string }>;
      expect(attempts).toEqual([{ status: "failed" }]);
    } finally {
      db.close();
    }
  });
});
