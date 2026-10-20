#!/usr/bin/env node
import { requestAgentBridgeOutcome } from "../src/runOutcome.js";

/** Compatibility command: the existing wait form is equivalent to outcome continue. */
export function requestAgentBridgeWait(args: string[], env: Record<string, string | undefined> = process.env): string {
  return requestAgentBridgeOutcome(["continue", ...args], env);
}

try {
  process.stdout.write(requestAgentBridgeWait(process.argv.slice(2)) + "\n");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`agent-bridge-wait: ${message}\n`);
  process.exit(1);
}
