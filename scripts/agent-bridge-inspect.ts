#!/usr/bin/env node
import { renderAgentBridgeInspection } from "../src/runtimeInspector.js";

try {
  process.stdout.write(renderAgentBridgeInspection(process.argv.slice(2)) + "\n");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`agent-bridge-inspect: ${message}\n`);
  process.exit(1);
}
