#!/usr/bin/env tsx

/**
 * Genuinely runnable shell entry point for runAutonomousGoalOperatorStandalone
 * (src/autonomousGoalRuntime.ts). No automatic poller drains autonomous
 * goals today; this is the smallest existing seam an operator (or another
 * process on the same host, e.g. a company goal bootstrap script) uses to
 * create and drain one under its own durable constraints/provider.
 */
import { runAutonomousGoalOperatorStandalone } from "../src/autonomousGoalRuntime.js";

function usage(): never {
  console.error([
    "Usage:",
    "  npx tsx scripts/autonomous-goal-operator.ts <db-path> create <goal-id> <prompt...> [--constraints c1|c2] [--bot name] [--max-cycles N]",
    "  npx tsx scripts/autonomous-goal-operator.ts <db-path> run <goal-id>",
    "  npx tsx scripts/autonomous-goal-operator.ts <db-path> status <goal-id>",
  ].join("\n"));
  process.exit(1);
}

async function main(): Promise<void> {
  const [databasePath, ...operatorArgs] = process.argv.slice(2);
  if (!databasePath || operatorArgs.length === 0) usage();
  const goal = await runAutonomousGoalOperatorStandalone(databasePath, operatorArgs);
  console.log(JSON.stringify(goal, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
