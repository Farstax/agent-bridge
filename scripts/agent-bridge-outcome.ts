#!/usr/bin/env node
import { requestAgentBridgeOutcome } from "../src/runOutcome.js";

try {
  process.stdout.write(requestAgentBridgeOutcome(process.argv.slice(2)) + "\n");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`agent-bridge-outcome: ${message}\n`);
  process.exit(1);
}
