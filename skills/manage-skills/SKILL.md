---
name: manage-skills
description: Use when the user asks to create, import, save, update, verify, repair, or remove a user-managed Skill without changing Agent Bridge's bundled Skills.
---

# Manage User Skills

Use Agent Bridge's existing shared-skill projection. Do not create another skill registry or provider-specific copy workflow.

## Ownership

- Bundled Agent Bridge Skills live in the active release's `skills/` directory and are managed by the release.
- User-managed Skills live canonically at `~/.agents/skills/<skill-name>/SKILL.md` (`SHARED_MEMORY_HOME` takes precedence over `HOME` when configured). They may be authored by the user or explicitly imported from a trusted external source.
- User Skills project as symlinks into native provider directories so the canonical Skill remains authoritative:
  - Codex: `~/.codex/skills/<skill-name>`
  - Claude: `~/.claude/skills/<skill-name>`
  - Antigravity/Agy: `~/.gemini/antigravity-cli/skills/<skill-name>`
- Cursor is excluded from that universal projection. The canonical Cursor-native path is `~/.cursor/skills/<skill-name>/SKILL.md` and is created only when explicitly requested.
- Do not edit a bundled Skill when the user intends to create or import their own managed Skill.

## Create or save

1. Choose a unique lowercase kebab-case name, 1-64 characters.
2. From the active Agent Bridge release, run `npm run skills -- list` and reject a name that collides with a bundled Skill.
3. Create `~/.agents/skills/<name>/SKILL.md` with standards-compatible frontmatter:

```markdown
---
name: my-skill
description: Use when ...
---

# My Skill
```

4. Keep the description non-empty and at most 1024 characters. `skill.json` is optional legacy metadata; do not create it unless a concrete compatibility need exists.
5. Project/register the canonical user Skill with:

```bash
npm run skills -- project-user <name>
```

6. If Cursor-native projection is explicitly required, add it with one of:

```bash
npm run skills -- project-user <name> --project-cursor
npm run skills -- project-cursor <name>
```

Do not create duplicate Claude/Codex/Cursor projections unless the operator accepts Cursor's cross-CLI discovery ambiguity. Never overwrite an unmanaged `~/.cursor/skills/<name>` path.

7. Verify it:

```bash
npm run skills -- verify <name>
```

## Import a trusted external Skill

Use the manager instead of copying an external Skill directly into canonical storage:

```bash
npm run skills -- import-user /path/to/<skill-name>
npm run skills -- verify <skill-name>
```

`import-user` validates the external Skill through the normal installer, copies the complete folder into `~/.agents/skills/<skill-name>`, records it as user-managed, and creates the normal Codex/Claude/Agy projections. It fails closed on bundled-name collisions, an existing canonical Skill, corrupt lock state, or unrelated native provider content. Its temporary staging directory is removed on success or failure. The supplied source directory remains caller-owned and is not removed.

Only import a Skill from a source the operator trusts. Importing a Skill does not install or qualify tools, MCP servers, credentials, binaries, network access, or other runtime dependencies that its instructions expect.

For the official OpenAI Docs Skill, the current upstream folder and Skill name are `skills/.curated/openai-docs` / `openai-docs` rather than `docs`. After importing it, the Skill itself requires the OpenAI developer-docs MCP server for its primary non-Codex docs path. Qualify that dependency separately:

```bash
codex mcp add openaiDeveloperDocs --url https://developers.openai.com/mcp
```

Then start a fresh Codex session and confirm the OpenAI developer-docs MCP tools are available before treating the Skill's MCP-backed workflow as qualified. `npm run skills -- verify openai-docs` proves managed Skill storage/projection integrity; it does not prove the MCP server is callable.

## Update or repair

Edit only the canonical `~/.agents/skills/<name>` content, then run `project-user` again so the lock hash and native symlinks are refreshed. Finish with `verify`.

If a managed native projection is missing, rerunning `project-user` repairs it. If a native path exists but is no longer the expected symlink to the canonical Skill, `project-user` fails closed instead of overwriting it; inspect that collision before changing or deleting anything.

Do not use `verify --fix` for user-managed Skills: the generic bundled-skill repair path can replace a conflicting native entry. `project-user` is the fail-closed repair path for user Skills.

## Remove

Only when the user explicitly wants the user-managed Skill removed:

```bash
npm run skills -- uninstall-user <name>
```

This removes the canonical shared Skill, its expected native symlink projections, and its lockfile record. It fails closed if a native path has been replaced with unrelated content. Never use the generic bundled `uninstall` command for a user-managed Skill.

## Completion evidence

Report the canonical path and whether `npm run skills -- verify <name>` passed. For an imported Skill, separately report whether any external runtime dependencies it requires were actually qualified. Do not dump the full Skill body unless the user asks for it.
