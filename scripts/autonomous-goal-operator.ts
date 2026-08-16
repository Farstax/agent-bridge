#!/usr/bin/env tsx

/**
 * Genuinely runnable shell entry point for runAutonomousGoalOperatorStandalone
 * (src/autonomousGoalRuntime.ts). No automatic poller drains autonomous
 * goals today; this is the smallest existing seam an operator (or another
 * process on the same host, e.g. a company goal bootstrap script) uses to
 * create and drain one under its own durable constraints/provider.
 *
 * Run as a fresh `npx tsx` process outside the agent-bridge-local systemd
 * unit, this does NOT automatically inherit that unit's
 * EnvironmentFile=/etc/agent-bridge-local/env the way the running bridge
 * process does — so without loading it explicitly, "run" would build its
 * standalone engine (and workspace-context delivery) without
 * AGENT_BRIDGE_WORKSPACE_CONTEXT_FILE or the CODEX_COMMAND/CLAUDE_COMMAND/
 * ANTIGRAVITY_COMMAND overrides the running bridge already has.
 */
import { existsSync } from "node:fs";
import { config as loadDotenv } from "dotenv";
import { runAutonomousGoalOperatorStandalone } from "../src/autonomousGoalRuntime.js";

function usage(): never {
  console.error([
    "Usage:",
    "  npx tsx scripts/autonomous-goal-operator.ts <db-path> create <goal-id> <prompt...> [--constraints c1|c2] [--bot name] [--max-cycles N]",
    "  npx tsx scripts/autonomous-goal-operator.ts <db-path> run <goal-id>",
    "  npx tsx scripts/autonomous-goal-operator.ts <db-path> status <goal-id>",
    "  npx tsx scripts/autonomous-goal-operator.ts <db-path> cancel <goal-id> [reason...]",
  ].join("\n"));
  process.exit(1);
}

/**
 * "run" emits one JSONL line per reconciled cycle to stdout as it drains
 * (type: "autonomous_cycle_reconciled"), then one final line
 * (type: "goal_result") once the episode is terminal or budget-exhausted.
 * A caller that only shells out and waits for the process to exit (not a
 * live stream) can still recover per-cycle narrative by parsing stdout
 * line-by-line after the process returns.
 */
async function main(): Promise<void> {
  const envFile = process.env.LOCAL_BRIDGE_ENV_FILE || "/etc/agent-bridge-local/env";
  if (existsSync(envFile)) loadDotenv({ path: envFile, override: false, quiet: true });

  const [databasePath, ...operatorArgs] = process.argv.slice(2);
  if (!databasePath || operatorArgs.length === 0) usage();
  const goal = await runAutonomousGoalOperatorStandalone(databasePath, operatorArgs, {
    onCycleReconciled: (event) => console.log(JSON.stringify(event)),
  });
  console.log(JSON.stringify({ type: "goal_result", ...goal }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
