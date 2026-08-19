# Architecture decisions

The current decision is to keep Agent Bridge surface-neutral and provider
native. Ordinary Runs own Bridge execution state; provider-native lifecycle owns
provider background/task completion. `AGENTS.md`, Skills, provider tools, and
native subagents own engineering workflow. Durable health
and autonomous receipts feed ordinary Runs.

Earlier split-product and role-orchestration decisions are historical. They do
not authorise a Worker runtime or a replacement workflow system.
