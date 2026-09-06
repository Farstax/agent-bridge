# Optional Skill Packs

Agent Bridge keeps its core Skills small. Optional domain capability sets live outside this repository and are installed as **Skill Packs**. A pack is only a versioned manifest over ordinary Skills; it does not add a plugin runtime, daemon, scheduler, agent hierarchy, or per-run network fetch.

The curated upstream is `Farstax/agent-bridge-skills`. Remote catalogue discovery is restricted to that repository. Local catalogue paths are supported for development, qualification, and mirrors under direct operator control.

## Metadata contract

`docs/skill-pack.schema.json` documents schema version `1`. A catalogue has its own semantic version and may contain several semantic versions of the same pack id. Each pack declares:

- stable id, display name, description, version, maintainer and licence;
- categories and generic capability tags that higher-level products may use without creating a Stack dependency;
- Agent Bridge API/version compatibility and supported agent hosts;
- required/optional local dependencies, external services, hosted MCPs and authorization requirements;
- required secret **names and purposes only**;
- effect classes: `local-read`, `external-read`, `draft-write`, `external-write`, `spend-mutation`;
- approval guidance, attribution references and test/eval entry points;
- included Skills and their exact content source.

Each Skill records a repository, exact revision, path and SHA-256 directory digest plus provenance. GitHub content and GitHub upstream provenance use exact 40-character commit SHAs. Adapted/vendored upstream Skills must name the upstream repository, revision, SPDX licence, required notice path and notice SHA-256, whether Farstax modified the content, and the last upstream review date.

Unknown metadata fields fail closed. Secret objects accept only `name` and `purpose`; secret values cannot be placed in a pack manifest.

## Discovery and inspection

The default catalogue is:

```text
https://raw.githubusercontent.com/Farstax/agent-bridge-skills/main/catalogue.json
```

List available pack versions:

```bash
npm run skills -- packs list
```

Inspect all metadata before installing:

```bash
npm run skills -- packs show marketing
npm run skills -- packs show marketing --version 1.2.0
```

For local qualification:

```bash
npm run skills -- packs list --catalogue /path/to/catalogue.json
```

## Install

Install the newest version of a pack present in the catalogue:

```bash
npm run skills -- packs install marketing
```

Install an exact version:

```bash
npm run skills -- packs install marketing --version 1.2.0
```

Install one ordinary Skill from a pack without installing the pack:

```bash
npm run skills -- packs install-skill marketing campaign-research --version 1.2.0
```

Before shared storage is changed, Agent Bridge validates the catalogue, compatibility, ownership/collisions, exact revisions and SHA-256 content. The existing Skill installer then writes the canonical `~/.agents/skills/<name>` copy and the normal Codex, Claude and Agy projections. Cursor remains explicit, matching core Skill behavior.

Pack installation never configures a declared MCP/service, performs OAuth, authorizes an account, supplies a secret, or grants external mutation/spend authority. Those remain owned by the existing runtime/tool/account approval boundaries.

## Installed state and provenance

Inspect installed packs and individually installed pack Skills:

```bash
npm run skills -- packs status
```

Agent Bridge stores pack reference/provenance/dependency state at:

```text
~/.agents/.skill-pack-lock.json
~/.agents/skill-packs/manifests/<pack-id>.json
~/.agents/skill-packs/notices/<skill-id>/...
```

The ordinary Skill itself still lives at `~/.agents/skills/<skill-id>` and uses the existing provider-native projection paths.

Pack-managed Skills intentionally use the existing core Skill lock ownership class internally, while `.skill-pack-lock.json` is the authority distinguishing them from user-authored Skills. `project-user` and `uninstall-user` fail closed for a Skill present in pack state; use the pack commands instead.

## Update and remove

Update to the newest catalogue version of a pack, or pin a target version:

```bash
npm run skills -- packs update marketing
npm run skills -- packs update marketing --version 1.3.0
```

A shared Skill may be referenced by several packs. A pack cannot change a shared Skill to different content while another pack or an explicit single-Skill install still references the installed content. That conflict fails closed instead of silently choosing a winner.

Pack convergence is restartable. Desired pack ownership/metadata is persisted before the ordinary Skill mutation, so retry can complete an interrupted install/update if the shared Skill is missing or still has the previous content. Existing native projections are checked before any force replacement; unmanaged provider content is never overwritten. A published pack version is immutable locally: if the same installed version reappears with a different manifest digest, update fails and requires a new pack version.

Remove a pack:

```bash
npm run skills -- packs remove marketing
```

Removing a pack only deletes a Skill after its final pack reference is gone and it is not explicitly installed. Remove an explicit single-Skill reference with:

```bash
npm run skills -- packs remove-skill campaign-research
```

Core bundled Skills and unrelated user-authored Skills are never pack removal targets.

## Catalogue authoring invariants

- Publish immutable pack versions. Reuse neither a pack version nor a pinned content revision for different content.
- Pin GitHub Skill content to a commit SHA and record the SHA-256 directory digest emitted by the pack qualification tooling/process.
- Preserve licence notices and exact upstream identity for adapted/vendored work.
- Declare external services, hosted MCPs, authorization, secret names, side effects and spend capability before publication.
- Keep pack content in the external curated repository; Agent Bridge should contain only mechanism code and minimal test fixtures.
- Do not add runtime fetching. Catalogue/content resolution occurs only during explicit pack management operations.
