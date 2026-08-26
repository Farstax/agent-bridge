---
status: authoritative
type: architecture
authority: canonical
implementation_status: implemented
last_validated_against: issue-544
---

# Conversation History and CLI Handoff Architecture

## Purpose

This document defines the supported continuity model for Agent Bridge.

Agent Bridge relies on provider-native sessions for same-provider continuity and retained exact conversation turns for fresh-session or cross-provider handoff. Generated compact summaries and project-memory execution paths are retired compatibility behavior and are no longer part of the runtime architecture.

## Decision Summary

The supported model is:

```text
provider-native session
  -> normal same-provider continuity

retained conversation_turns
  -> bounded one-time fresh-session handoff
  -> scoped --search for older evidence
  -> new provider-native session
```

Agent Bridge does not generate a replacement summary or silently promote assistant output into project memory as part of ordinary conversation handling.

## Continuity Sources

### Native CLI Session Memory

Native CLI session memory belongs to the provider CLI: Codex, Claude, Antigravity, Grok, Cursor, or another supported runtime.

Agent Bridge relies on the provider session identifier for ordinary continuation. A resumed invocation does not receive a repeated Agent Bridge history preamble.

### Retained Conversation Turns

`conversation_turns` are the Agent Bridge-owned cross-session evidence for a chat/thread.

They are retained as exact source turns and are used to:

- orient a provider when a fresh native session is required;
- continue work after a manual provider switch or capacity fallback;
- recover from an invalid provider session;
- support scoped older-history retrieval through `agent-bridge-context --search`;
- support bounded recent-history retrieval through `agent-bridge-context --recent`.

The fresh-session handoff is bounded by the configured context budget. The stored source turns remain available beyond that prompt window through scoped retrieval.

### Historical Summary and Memory Rows

Existing `conversation_summaries`, `project_memories`, and related historical tables may remain in databases for compatibility, audit, and safe rollback of older releases.

Current runtime continuity does not read them into provider prompts, generate new compact summaries, or write new project-memory candidates. Retiring the execution paths does not require destructive data migration.

### SOUL.md

`SOUL.md` is runtime operating context and persona policy. It is not conversation history.

## Fresh Provider Handoff

A fresh provider invocation receives one bounded handoff built from exact retained turns.

The handoff should communicate:

- user goal;
- what was done and available evidence;
- current state;
- pending or next steps;
- key context and constraints;
- how to query older retained evidence when needed.

The runtime also exposes `AGENT_BRIDGE_CONTEXT_COMMAND` when retained context is available. Supported retrieval is:

```bash
"$AGENT_BRIDGE_CONTEXT_COMMAND" --recent 20
"$AGENT_BRIDGE_CONTEXT_COMMAND" --search "<terms>"
```

The helper is scoped to the current conversation key. It must not cross chat/thread boundaries.

After the target provider persists native session evidence, Agent Bridge clears the handoff-required marker and relies on native continuity thereafter.

## Manual Provider Switching

Manual provider switching starts a fresh target provider session.

```text
set selected provider preference
clear target provider session for this chat/thread
mark handoff required
next user turn receives bounded exact-turn handoff once
persist new provider session ID
clear handoff marker
```

Agent Bridge does not compact before switching.

## Capacity Fallback

Capacity fallback uses the same handoff model as manual switching.

```text
active provider reports capacity exhaustion
select next available provider
clear target provider session for this chat/thread
mark handoff required
replay the current user update into the target provider
inject bounded exact-turn handoff once
persist target provider session ID
clear handoff marker
```

No generated-summary call, project-memory promotion, or compaction cooldown is required.

## Invalid Session Recovery

When a provider reports an invalid or unusable native session, Agent Bridge clears that session and performs a bounded fresh retry with exact retained turns. The retry must not duplicate the current turn or wrap the prompt in nested handoff blocks.

Provider-specific recovery rules remain owned by the provider runtime; the continuity evidence comes from retained turns.

## Context Helper

`agent-bridge-context` is an agent-facing exact-turn retrieval helper.

Supported modes are:

- `--recent <n>` for bounded recent exact turns;
- `--search <query>` for scoped older evidence.

Historical generated-summary and project-memory helper flags are not supported retrieval paths. They must not expose stored summary or project-memory contents.

The human-facing `/context` command is diagnostics only. It reports retained-turn and pending-queue status and points to the supported exact-turn retrieval path; it is not a memory browser.

## Reset Semantics

`/reset` is the explicit user-controlled history deletion path for the current conversation scope.

It clears:

- the scoped provider session;
- pending work for that conversation;
- retained conversation turns;
- historical summaries for that conversation.

It does not delete unrelated conversations or perform global historical-memory cleanup.

## Persistence and Data Safety

Retained turns are source evidence. Normal operation must not prune them because a generated derivative exists.

Historical summary/memory tables can remain present without being active runtime dependencies. Removing those rows or tables is a separate destructive data-migration decision and is outside issue #544.

## Non-Goals

This design does not introduce:

- generated compact-summary continuity;
- project-memory promotion from assistant output;
- hidden memory sidecars;
- vector databases or embeddings;
- a second history store;
- a replacement workflow/task queue;
- automatic destructive retention cleanup.

## Historical References

Older issue #69 and compaction roadmap documents describe the superseded generated-summary/project-memory design and remain as historical delivery records. This document is authoritative for current runtime behavior.
