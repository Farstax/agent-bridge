#!/usr/bin/env node
import { requestAgentBridgeWait } from "../src/runOutcome.js";

export { requestAgentBridgeWait } from "../src/runOutcome.js";

try {
  process.stdout.write(requestAgentBridgeWait(process.argv.slice(2)) + "\n");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`agent-bridge-wait: ${message}\n`);
  process.exit(1);
}
