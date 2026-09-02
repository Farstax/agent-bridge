# Antigravity / Agy repository notes

`AGENTS.md` is authoritative for repository architecture, TDD, review, verification, release, restart, effort policy, and repository-grounded implementation explanations. Read it before making changes or answering implementation-specific questions; do not duplicate those rules here.

## Agy-specific boundary

- The supported CLI is Agy (`agy`) with Antigravity configuration names.
- Use Agy's native sessions, tools, Skills, and provider-side execution inside the owning Run; do not add Bridge-owned worker orchestration.
- Preserve the native structured-output and continuation contract used by Agent Bridge, with deterministic fixtures plus provider qualification for release-sensitive CLI behavior.
- Native Skills are projected under `~/.gemini/antigravity-cli/skills`; keep installation and qualification aligned with that path.
