# Skills and Collections

Agent Bridge installs **Skills**. A **Collection** is only a curated list of Skill ids for discovery and bulk install/remove convenience.

Collections do not define a runtime, permissions model, provider/tool requirements, MCPs, OAuth, secrets, services, effects, or Agent Bridge compatibility ranges. Runtime authority remains with the provider/tool boundary when a Skill is used.

## Catalogue contract

The schema is `docs/skill-collection.schema.json` (`schemaVersion: 2`). A catalogue has one canonical definition for each managed Skill and lightweight Collections that reference those ids:

```json
{
  "schemaVersion": 2,
  "catalogueId": "farstax-skills",
  "skills": [
    {
      "id": "research",
      "description": "Reusable research workflow.",
      "content": {
        "repository": "https://github.com/example/skills",
        "revision": "0123456789abcdef0123456789abcdef01234567",
        "path": "skills/research",
        "sha256": "<sha256>"
      },
      "provenance": {
        "origin": "author-created",
        "modifiedFromUpstream": false,
        "lastReviewed": "2026-09-14"
      }
    }
  ],
  "collections": [
    {
      "id": "marketing",
      "name": "Marketing",
      "description": "Useful marketing workflows.",
      "skills": ["research"]
    }
  ]
}
```

Managed GitHub Skill content is pinned to an exact 40-character commit SHA and verified against the declared directory SHA-256 before installation. Curated/adapted Skills retain provenance, licence and notice verification where required. A remote catalogue is management-time input only and must come from the repository named by `AGENT_BRIDGE_SKILL_COLLECTION_ALLOWED_REPO`; remote per-Run Skill loading is not supported.

## Commands

Ordinary Skills remain the installed capability:

```bash
npm run skills -- install <skill-id> --catalogue <source>
npm run skills -- uninstall <skill-id>
```

Collections are convenience operations:

```bash
npm run skills -- collections list --catalogue <source>
npm run skills -- collections show <collection-id> --catalogue <source>
npm run skills -- collections install <collection-id> --catalogue <source>
npm run skills -- collections update <collection-id> --catalogue <source>
npm run skills -- collections remove <collection-id>
npm run skills -- collections status
```

`AGENT_BRIDGE_SKILL_COLLECTION_CATALOGUE` can provide the default catalogue source. `--catalogue` overrides it.

## Installed state

The ordinary shared Skill store and `src/skills.ts` registration/projection path remain authoritative for whether a Skill is installed and usable. Collection bookkeeping at `~/.agents/.skill-collection-lock.json` records only:

- installed Collection source and referenced Skill ids;
- whether a managed Skill was installed directly;
- Collection references needed for safe removal;
- exact content/provenance needed to verify managed updates and notices.

Removing one Collection never removes a Skill that is still referenced by another Collection or directly installed. User-authored/unmanaged Skills and provider-native paths are never claimed or overwritten.

## Migration from Skill Pack state

On first Collection-manager state read, a valid legacy `~/.agents/.skill-pack-lock.json` is converted in place to state version 2. Existing ordinary Skills are not reinstalled. Pack references become Collection references; pinned content/provenance and required notices are retained. After the new state is written atomically, obsolete Pack lock/manifests/notices are removed. Repeated reads are idempotent.

The v1 Pack catalogue/command contract is intentionally not retained. Curated repositories should publish the v2 canonical-Skill/Collection schema instead of carrying Pack semantic versions, compatibility ranges, dependency/effect metadata, duplicated per-Collection Skill contracts, or Pack-specific single-Skill lifecycle commands.
