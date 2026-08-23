---
name: manage-skills
description: Use when the user asks to create, save, update, verify, repair, or remove a user-authored Skill without changing Agent Bridge's bundled Skills.
---

# Manage User Skills

Use Agent Bridge's existing shared-skill projection. Do not create another skill registry or provider-specific copy workflow.

## Ownership

- Bundled Agent Bridge Skills live in the active release's `skills/` directory and are managed by the release.
- User-authored Skills live canonically at `~/.agents/skills/<skill-name>/SKILL.md` (`SHARED_MEMORY_HOME` takes precedence over `HOME` when configured).
- User Skills project as symlinks into native provider directories so the canonical Skill remains authoritative:
  - Codex: `~/.codex/skills/<skill-name>`
  - Claude: `~/.claude/skills/<skill-name>`
  - Antigravity/Agy: `~/.gemini/antigravity-cli/skills/<skill-name>`
- Do not edit a bundled Skill when the user intends to create their own Skill.

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

6. Verify it:

```bash
npm run skills -- verify <name>
```

## Update or repair

Edit only the canonical `~/.agents/skills/<name>` content, then run `project-user` again so the lock hash and native symlinks are refreshed. Finish with `verify`.

If a managed native projection is missing, rerunning `project-user` repairs it. If a native path exists but is no longer the expected symlink to the canonical Skill, `project-user` fails closed instead of overwriting it; inspect that collision before changing or deleting anything.

Do not use `verify --fix` for user-authored Skills: the generic bundled-skill repair path can replace a conflicting native entry. `project-user` is the fail-closed repair path for user Skills.

## Remove

Only when the user explicitly wants the user Skill removed:

```bash
npm run skills -- uninstall <name>
```

This removes the canonical shared Skill, Agent Bridge's native projections, and its lockfile record. Never use it to remove a bundled release Skill unless that is explicitly the requested operation.

## Completion evidence

Report the canonical path and whether `npm run skills -- verify <name>` passed. Do not dump the full Skill body unless the user asks for it.
