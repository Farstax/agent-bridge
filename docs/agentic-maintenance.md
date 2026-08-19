# Agentic Maintenance Workflow

## Status

Canonical operating model. Agent Bridge provides conversational context,
durable evidence, execution safety, and provider invocation. The provider
agent follows repository-local `AGENTS.md`, bundled Skills, provider-native
tools, and native subagents.

## Interactive work

```text
conversation
  -> turns and history
  -> provider-native session
  -> ordinary Run
  -> provider-native terminal completion
  -> provider agent + AGENTS.md + Skills + tools
  -> result or external artifact
```

The phrase `ship it` is a normal provider-agent request. Agent Bridge does not
create a Worker job, role chain, task record, or replacement workflow engine.

## Unattended work

```text
authenticated and idempotent event receipt
  -> ordinary owning Run
  -> the same provider agent and Skills path
  -> result
```

Health and autonomous-goal services keep their existing durable ingress,
ownership, retry, cancellation, and restart recovery rules. Event receipts and
Runs remain the source of execution state. Historical Worker tables are not
created, claimed, or executed.

## Safety boundary

Agent Bridge retains provider selection, process supervision, session and Run
durability, fencing, cancellation, fallback, restart reconciliation, and
delivery completion. Provider-native background work stays inside the owning
provider invocation. Repository instructions and Skills own engineering
workflow policy. Provider-native subagents remain inside the provider process.

The final parsed provider result is authoritative for persistence, session
state, terminal events, attachments, and delivery. Preview or
diagnostic data cannot complete a Run.

## Review and release

Repository-local instructions and bundled Skills define the normal red-green
test flow, review evidence, exact-head checks, merge, and cleanup steps. Human
approval remains required for product decisions, material scope changes,
destructive actions, merge authority, and deployment.
