---
status: authoritative
type: architecture
authority: canonical
implementation_status: partially-implemented
last_validated_against: issue-69
---

# Compact Memory and CLI Handoff Architecture

## Purpose

This document defines the intended memory and provider-handoff architecture for Agent Bridge.

It supersedes the post-turn memory extractor direction and makes compaction the single durable-memory distillation point for conversational and unattended Run paths.

**Implementation status:** the post-turn extractor removal, structured compact output, compact profiles, shared compaction service, latest-N recent-turn fix, and manual-switch/fallback handoff wiring are implemented on `main`. Fresh provider invocations receive one bounded handoff and resumed invocations use provider-native continuity. Handoff markers remain durable until provider-session evidence is persisted. Minimal pre-seed compaction is controlled by `BRIDGE_PRESEED_COMPACT_MODE` and `BRIDGE_PRESEED_COMPACT_CHARS`. See `docs/roadmap/issue-69-compact-memory-handoff.md` for the current PR-by-PR status.

## Decision Summary

Agent Bridge should use compact-based memory promotion instead of per-turn automatic extraction.

The target design is:

```text
conversation turns
  -> compact summary
  -> validated persistent memory candidates
  -> project_memories
  -> selective memory search by future agents
```

Provider switching and fallback should use one consistent handoff model:

```text
prepare handoff context
  -> start a fresh target CLI session
  -> inject Agent Bridge context once
  -> store target CLI session ID
  -> rely on native CLI session continuity thereafter
```

## Memory Types

### Native CLI Session Memory

Native CLI session memory belongs to the provider CLI: Codex, Claude, Antigravity, or another supported runtime.

Agent Bridge should rely on this for continuity inside a single provider session.

Native session memory is not cross-provider memory.

### Conversation Turns

Conversation turns are short-term Agent Bridge history for a chat/thread.

They are used to:

- support first-turn seeding for a fresh CLI session;
- provide recent detail after the latest compact summary;
- preserve context until compaction succeeds.

Conversation turns should not be the long-term memory system.

### Compact Summaries

Compact summaries are the authoritative cross-provider handoff context.

A compact summary should contain:

```text
Current objective:
- What the user or agent is trying to achieve.

Durable facts:
- Stable facts, decisions, constraints, identifiers, and context that should survive provider sessions.

Open state:
- Unresolved questions, pending approvals, blocked items, next actions, or work to continue.
```

Compact summaries are stored in `conversation_summaries`.

### Persistent Memories

Persistent memories are validated durable facts stored in `project_memories`.

They should be promoted from compaction, not extracted after every turn.

Persistent memories are for facts that should be searchable across future interactions, such as:

- durable user preferences or constraints;
- accepted project decisions;
- repository or architecture conventions;
- unresolved long-lived TODOs;
- recurring context that is likely to matter again.

### SOUL.md

`SOUL.md` is runtime operating context and persona policy. It is not conversation memory and not persistent factual memory.

## Removed Design: Post-Turn Extractor

The post-turn extractor should be removed completely.

Remove:

- `src/memoryExtractor.ts`;
- `BRIDGE_MEMORY_EXTRACTOR_ENABLED` runtime behavior;
- `_extractPostTurnMemories()`;
- calls after `_rememberTurn()`;
- extractor-specific tests and documentation.

Keep:

- `project_memories`;
- `MemoryRepository`;
- `storeProjectMemoryCandidate()`;
- memory FTS search;
- `agent-bridge-context --memory` and `--memory-query` affordances.

Reasoning:

- per-turn extraction can silently mutate persistent memory;
- it creates extra model calls after every turn when enabled;
- it is harder to govern than compact-based promotion;
- compaction is already the deliberate distillation moment.

## Compact Output Contract

Compaction should produce a structured result:

```json
{
  "summary_md": "Current objective:\n- ...\n\nDurable facts:\n- ...\n\nOpen state:\n- ...",
  "memory_candidates": [
    {
      "type": "decision",
      "scope": "project",
      "text": "Durable standalone fact for future agents.",
      "confidence": 0.9
    }
  ]
}
```

`summary_md` is stored in `conversation_summaries`.

`memory_candidates` are passed through the existing `storeProjectMemoryCandidate()` validation path before being inserted into `project_memories`.

Rejected and duplicate candidates should be visible in debug logs or returned service metadata. They must not fail compaction.

## Compact Profiles

Compaction must support at least two profiles.

### Companion Profile

Used by the Companion Runtime and interactive/companion bot.

The companion profile is domain-agnostic. It must not assume the conversation is an engineering task.

It should preserve:

- user preferences;
- constraints;
- named people, projects, places, and entities;
- recurring context;
- decisions;
- health/training/travel/home/work context where relevant;
- technical or project decisions when the conversation is technical;
- open questions and next actions.

### Engineering Profile

Used by provider-native engineering flows and other coding-specific Runs.

It should preserve:

- repository names and paths;
- branches;
- PR and issue numbers;
- file paths;
- commands and test results;
- architecture decisions;
- accepted/rejected implementation choices;
- Run and attempt IDs;
- pending approvals;
- failing checks and open blockers.

## Single Compaction Service

Normal `/compact`, fallback compaction, and switch handoff compaction should share one core service.

Suggested interface:

```ts
compactConversation(input: {
  chatKey: string;
  profile: "companion" | "engineering";
  mode: "manual" | "fallback_handoff" | "switch_handoff" | "scheduled";
  pruneOnSuccess?: boolean;
}): Promise<{
  summaryStored: boolean;
  summaryMd?: string;
  promotedMemoryIds: string[];
  rejectedCandidates: Array<{ reason: string; text?: string }>;
  range?: { startTurnId: number; endTurnId: number };
  error?: string;
}>;
```

The engine should decide when compaction is needed. The compaction service should own summarisation, reduce, memory promotion, pruning decisions, and failure semantics.

## Failure Semantics

Compaction failure must be non-destructive.

If compaction succeeds:

```text
store summary
promote validated memory candidates
prune raw turns covered by the stored summary, when requested
prepare handoff if needed
```

If compaction fails:

```text
do not store a replacement summary
do not prune raw turns
do not overwrite useful context with a weak tombstone
continue with previous summary + available recent turns
log/report the failure
```

Tombstones may be useful as diagnostics, but they must not be treated as successful summaries that justify pruning raw turns.

## Handoff Context

Handoff context is the one-time Agent Bridge context injected when starting a fresh provider session.

It should include:

- the latest compact summary;
- the latest N recent turns after the summary, bounded by the configured char budget;
- instructions for using `AGENT_BRIDGE_CONTEXT_COMMAND`;
- memory-search guidance.

Suggested prompt guidance:

```text
[Agent Bridge handoff context]
This is a fresh provider session. Use this handoff context to continue naturally.
Search Agent Bridge memory when the request may depend on prior user preferences, project decisions, unresolved work, recurring constraints, or repo/project conventions.
Do not dump memory into the answer; use it only to ground continuity.
```

After the first successful target CLI response, Agent Bridge should clear the handoff-required flag and rely on the native CLI session ID.

## Interactive/Companion CLI Switching

Manual provider switching in the interactive/companion bot should start a fresh target CLI session.

On manual switch:

```text
set selected CLI preference
clear target CLI session for this chat/thread
mark handoff required for target CLI
next user turn injects handoff context once
store new target CLI session ID
clear handoff flag
```

Continuing the same selected CLI session should not repeatedly inject full Agent Bridge context.

## Fallback Handoff

Capacity fallback should use the same handoff method as manual switching.

On fallback:

```text
active CLI reports capacity exhaustion
attempt compactConversation(... mode: fallback_handoff ...)
continue even if compaction fails
select next available CLI
clear next CLI session for this chat/thread
mark handoff required for next CLI
replay current user update into next CLI
inject handoff context once
store next CLI session ID
clear handoff flag
```

Fallback compaction should have a cooldown to prevent repeated expensive compactions during provider outage loops.

Suggested default:

```text
BRIDGE_FALLBACK_COMPACT_COOLDOWN_MS=300000
```

## Individual CLI Bots

Individual CLI bots may continue to rely primarily on the native CLI session continuity.

They should not need cross-provider handoff for normal operation.

They still may use compact summaries when:

- `/compact` is explicitly requested;
- the native session is invalid and a fresh provider session is required;
- a configured policy decides first-turn seeding is needed.

## Recent-Turn Policy

Handoff context must use:

```text
latest compact summary + latest N turns after that summary
```

It must not use the first N turns after the latest summary.

This distinction matters when more than N turns exist after the latest summary. The newest turns are the most relevant to immediate continuation.

Compaction itself must process all un-compacted turns since the latest summary via chunking. It must not depend on the handoff recent-turn cap.

## More Than 200 Turns Since Last Summary

The current context-building strategy should be corrected if it fetches the first 200 turns after the latest summary.

Correct behavior:

- prompt handoff uses the latest N turns after the summary;
- compaction processes the full un-compacted backlog;
- N and/or char budget are configurable;
- un-compacted backlog size should trigger or recommend compaction before handoff context becomes stale.

Suggested config:

```text
BRIDGE_CONTEXT_MAX_CHARS=8000
BRIDGE_CONTEXT_RECENT_TURN_LIMIT=200
BRIDGE_COMPACT_AUTO_TURN_THRESHOLD=200
```

## Data and State Additions

Add handoff state using `settings` or a small dedicated table.

Suggested setting keys:

```text
handoff_required:<chatKey>:<cliKind> = 1
handoff_reason:<chatKey>:<cliKind> = first_turn | manual_switch | fallback | compact | invalid_session
handoff_last_compact_at:<chatKey> = <iso timestamp>
```

A dedicated table may be preferable if this expands.

## Agent Guidance for Memory Search

Agents should be encouraged to search memory selectively.

They should search when a request may depend on:

- prior user preferences;
- prior project decisions;
- recurring constraints;
- unresolved work;
- repo or architecture conventions;
- previous plans.

They should not blindly dump memory into answers.

## Non-Goals

This design does not introduce:

- vector databases;
- embeddings;
- silent per-turn persistent memory mutation;
- full cross-repo memory routing;
- broad service renames;
- a replacement workflow or task queue.

## Relationship to Issue #69

This document is the canonical architecture target for issue #69: compact-first memory, persistent memory promotion, and unified CLI handoff context.
