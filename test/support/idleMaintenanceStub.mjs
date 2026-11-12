// Deterministic stand-in for scripts/idle-maintenance.ts used by rollout
// fixtures whose databases are intentionally pre-fence legacy schemas (the real
// tool correctly reports `unknown` for them). It implements only the CLI
// contract the rollout helper consumes; real admission is exercised separately
// by the FAKE_REAL_IDLE=1 tests against current-schema databases.
import { randomUUID } from "node:crypto";

const [action, ...args] = process.argv.slice(2);
const dbs = [];
for (let index = 0; index < args.length; index++) if (args[index] === "--db") dbs.push(args[++index]);
if (action === "acquire") {
  // Model an unknown result after a partial acquisition could not be released.
  if (process.env.FAKE_IDLE_PARTIAL_UNKNOWN) process.exit(2);
  console.log(JSON.stringify({
    state: "admitted",
    roles: dbs.map((dbPath) => ({ dbPath, fence: { version: 1, token: randomUUID() } })),
  }));
} else if (action === "release") {
  console.log(JSON.stringify({ released: true }));
} else if (action === "status") {
  console.log(JSON.stringify({ state: "idle" }));
} else {
  process.exit(2);
}
