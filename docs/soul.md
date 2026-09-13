# SOUL.md — User-Owned Portable Identity File

`SOUL.md` is a plain, user-owned Markdown file defining an agent's persona, communication style, and operating posture across all supported CLI providers.

The bridge loads this file, safely bounds it, and injects it provider-neutrally through the existing prompt wrapper on every turn.

## Core Principles

- **Plain Markdown:** `SOUL.md` is ordinary author-written Markdown. It has no mandatory section schema, archetypes, or rigid formats. Custom headings, bullet lists, and prose are preserved as written.
- **Provider-Neutral Injection:** The same identity file applies consistently whether using Codex, Claude, Antigravity, or Grok.
- **Protected Safety Precedence:** Soul content is bounded and subordinate to platform guardrails, system prompts, authorization, and delivery rules. A safety precedence notice is included automatically with the rendered contract.
- **User-Owned & Portable:** The file belongs to the user or workspace. Missing or empty files result in neutral provider defaults without errors.

## Runtime Injection Model

On fresh sessions and non-continuation turns, the prompt wrapper injects the Soul contract at the top:

```text
Soul contract:
<SOUL.md content>

Higher-priority bridge/system/developer instructions always win.

User request:
<user message>
```

For Antigravity, the delimiter wrapper remains outside:

```text
You are being called by agent-bridge in non-interactive print mode.
When ready, output a line containing only ***.
After that line, output only the user-facing final answer.

Soul contract:
...
```

The bridge rebuilds this prompt wrapper every turn. After `/reset`, the fresh conversation continues to receive the configured Soul contract.

## Configuration

The Soul loader is configured via environment variables:

| Variable | Default | Values | Description |
|---|---|---|---|
| `AGENT_BRIDGE_SOUL_PATH` | `/etc/agent-bridge/prompt/SOUL.md` (or workspace-local) | File path | Path to the user's `SOUL.md` file. |
| `AGENT_BRIDGE_SOUL_MODE` | `summary` | `summary`, `full`, `off` | Injection mode and character boundary. |

### Modes and Limits

- **`summary` (default):** Bounded to 4,000 characters. Oversized files are safely truncated with a `[truncated]` marker.
- **`full`:** Bounded to 12,000 characters for rich identity configurations. Oversized files are safely truncated with a `[truncated]` marker.
- **`off`:** Completely disables Soul loading and prompt injection (operates in pure neutral provider mode).

## Recommended Structure

While no sections are mandatory, clear Markdown structure helps model steering:

```markdown
# Agent Identity

## Role & Voice
- Identity and role description.
- Tone and communication style (e.g. concise, direct, technical).

## Decision Principles
- Safety before speed.
- Clarity over cleverness.
- Preserve user trust.

## Operating Preferences
- Preferred patterns, test-first development, and verification steps.
```

## Relationship to Other Systems

- **Shared memory:** Persists durable project facts, decisions, and bug fixes across turns.
- **Shared skills:** Provides reusable procedural workflows and tools.
- **SOUL.md:** Governs persona, communication style, and operating posture.
