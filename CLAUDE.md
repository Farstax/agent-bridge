# Claude Code repository notes

`AGENTS.md` is authoritative for repository architecture, TDD, review, verification, release, restart, and effort policy. Read it before making changes; do not duplicate those rules here.

## Claude-specific boundary

- Use Claude Code's native session, continuation, tool, Skill, subagent, and background-process capabilities inside the owning Run.
- Do not recreate provider-native decomposition or execution as Bridge-owned worker machinery.
- Keep Claude runtime assumptions covered by deterministic fixtures and provider qualification when a CLI release could break them.
- Treat capacity exhaustion as a provider lifecycle event and use the existing Agent Bridge continuation/fallback path rather than inventing provider-specific orchestration.
