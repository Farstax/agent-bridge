import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type AutonomyDisposition = "continue" | "done" | "blocked";

/**
 * `blocked` ends the objective, so it must name why no further agent-only
 * action can make progress. A failed CI run, refused rollout admission, or
 * other stopped operation is not one of these: that is repairable evidence
 * for a `continue` successor Cycle.
 */
export type AutonomyEscalation = "authority" | "decision" | "external";

export interface AutonomyDispositionRecord {
  disposition: AutonomyDisposition;
  notify: boolean;
  escalation?: AutonomyEscalation;
}

export interface AutonomyDispositionChannel {
  commandPath: string;
  read(): AutonomyDispositionRecord | null;
  reset(): void;
  cleanup(): void;
}

const VALID_DISPOSITIONS = new Set<AutonomyDisposition>(["continue", "done", "blocked"]);
const VALID_ESCALATIONS = new Set<AutonomyEscalation>(["authority", "decision", "external"]);

function validateRecord(value: unknown): AutonomyDispositionRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid_autonomy_disposition");
  }
  const record = value as Record<string, unknown>;
  const blocked = record.disposition === "blocked";
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== (blocked ? "disposition,escalation,notify" : "disposition,notify")) {
    throw new Error("invalid_autonomy_disposition");
  }
  if (typeof record.disposition !== "string" || !VALID_DISPOSITIONS.has(record.disposition as AutonomyDisposition)) {
    throw new Error("invalid_autonomy_disposition");
  }
  if (typeof record.notify !== "boolean") {
    throw new Error("invalid_autonomy_disposition");
  }
  if (!blocked) return { disposition: record.disposition as AutonomyDisposition, notify: record.notify };
  if (typeof record.escalation !== "string" || !VALID_ESCALATIONS.has(record.escalation as AutonomyEscalation)) {
    throw new Error("invalid_autonomy_disposition");
  }
  return { disposition: "blocked", notify: record.notify, escalation: record.escalation as AutonomyEscalation };
}

export function createAutonomyDispositionChannel(runId: string): AutonomyDispositionChannel {
  const dir = mkdtempSync(join(tmpdir(), `agent-bridge-autonomy-${runId}-`));
  const recordPath = join(dir, "disposition.json");
  const commandPath = join(dir, "autonomy");
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
let notify = false;
if (args[args.length - 1] === "--notify") {
  notify = true;
  args.pop();
}
const valid = (args.length === 1 && ["continue", "done"].includes(args[0]))
  || (args.length === 2 && args[0] === "blocked" && ["authority", "decision", "external"].includes(args[1]));
if (!valid) {
  console.error("usage: autonomy continue|done|blocked authority|decision|external [--notify]");
  console.error("blocked ends the objective: use it only for missing authority, a required human decision, or an unresolvable external dependency. A failed CI run, refused rollout admission, or other stopped operation is repairable: repair and use continue.");
  process.exit(2);
}
const record = args[0] === "blocked" ? { disposition: "blocked", escalation: args[1], notify } : { disposition: args[0], notify };
const recordPath = ${JSON.stringify(recordPath)};
const tmpPath = \`\${recordPath}.\${process.pid}.\${Date.now()}.\${Math.random().toString(36).slice(2)}.tmp\`;
fs.writeFileSync(tmpPath, JSON.stringify(record), { flag: "wx", mode: 0o600 });
fs.renameSync(tmpPath, recordPath);
`;
  writeFileSync(commandPath, script, { mode: 0o700 });
  chmodSync(commandPath, 0o700);

  return {
    commandPath,
    read() {
      let text: string;
      try {
        text = readFileSync(recordPath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
      try {
        return validateRecord(JSON.parse(text));
      } catch (error) {
        if (error instanceof Error && error.message === "invalid_autonomy_disposition") throw error;
        throw new Error("invalid_autonomy_disposition");
      }
    },
    reset() {
      rmSync(recordPath, { force: true });
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
