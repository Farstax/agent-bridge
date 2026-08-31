# Runtime inspection for agents

Agent Bridge exposes a bounded, read-only JSON projection of the state it already owns. It is intended for provider agents that need to understand the current execution environment without reconstructing SQLite tables, process state, logs, or configuration.

Use:

```bash
bin/agent-bridge-inspect --json
bin/agent-bridge-inspect capabilities --json
```

Managed provider prompts also receive the absolute inspector path as a compact pointer. Detailed state is loaded only when the agent chooses to run the command.

## Projection boundaries

The inspector reads existing Agent Bridge state. It does not schedule work, execute a provider, mutate a session, create authority, or introduce a workflow/plugin runtime. Existing SQLite stores, provider qualification evidence, Skills metadata, scheduler state, autonomy receipts, surface state, and health reports remain authoritative.

Missing or stale evidence is reported as `unknown` or `unavailable` with a bounded `reasonCode`. The inspector does not convert missing evidence into guessed readiness and does not run live provider/network probes.

Output is capped at 32,000 characters and arrays are bounded. It deliberately omits raw prompts, routine instructions, autonomous objectives/constraints, session IDs, error text, health messages, credentials, tokens, cookies, private keys, and other secret-bearing payloads.

## Main sections

- `runtime`: package/commit identity, service context, database schema readiness, and material degradation codes.
- `providers`: selected provider, configured default model where present, and qualification evidence without claiming current qualification when the installed provider version was not observed.
- `execution`: active Runs, recent failed/cancelled/reconciled Runs, and active/expired execution locks using hashed conversation references.
- `sessions`: existence and creation time for the current conversation only; native session identifiers are never returned.
- `scheduledRoutines`: current-conversation routine metadata and recorded occurrence evidence. It does not create a second scheduler or invent Run correlation the store does not have.
- `autonomy`: bounded Episode identity/status/cycle budget and pending wake receipt correlation without objective or constraint text.
- `surfaces`: Telegram/Discord current-surface readiness without probing another surface.
- `health`: current aggregate status from fresh recorded reports plus missing/stale plugin evidence; no new polling.
- `knowledge`: installed/bundled Skills and discovery pointers for retained context, advisor, scheduled routines, supported providers, and supported chat surfaces.
- `capabilities`: bounded `id`, `owner`, `status`, `reasonCode`, `scope`, `risk`, `authorityRequired`, and `interface` metadata describing what is available here now. Capability metadata never grants authority.

The `capabilities --json` form returns only runtime identity plus the capability index for cheaper discovery.
