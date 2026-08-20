import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type AutonomyDisposition = "continue" | "done" | "blocked";

export interface AutonomyDispositionRecord {
  disposition: AutonomyDisposition;
  notify: boolean;
}

export interface AutonomyDispositionChannel {
  commandPath: string;
  read(): AutonomyDispositionRecord | null;
  reset(): void;
  cleanup(): void;
}

const VALID_DISPOSITIONS = new Set<AutonomyDisposition>(["continue", "done", "blocked"]);

function validateRecord(value: unknown): AutonomyDispositionRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid_autonomy_disposition");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "disposition,notify") {
    throw new Error("invalid_autonomy_disposition");
  }
  if (typeof record.disposition !== "string" || !VALID_DISPOSITIONS.has(record.disposition as AutonomyDisposition)) {
    throw new Error("invalid_autonomy_disposition");
  }
  if (typeof record.notify !== "boolean") {
    throw new Error("invalid_autonomy_disposition");
  }
  return { disposition: record.disposition as AutonomyDisposition, notify: record.notify };
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
if (args.length !== 1 || !["continue", "done", "blocked"].includes(args[0])) {
  console.error("usage: autonomy continue|done|blocked [--notify]");
  process.exit(2);
}
const recordPath = ${JSON.stringify(recordPath)};
const tmpPath = \`\${recordPath}.\${process.pid}.\${Date.now()}.\${Math.random().toString(36).slice(2)}.tmp\`;
fs.writeFileSync(tmpPath, JSON.stringify({ disposition: args[0], notify }), { flag: "wx", mode: 0o600 });
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
