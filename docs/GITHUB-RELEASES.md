# GitHub Releases

Agent Bridge GitHub Releases are published only through an explicit promotion of an already-qualified `Release Artifact` workflow run. Release publication does not rebuild the runtime and does not deploy it.

## Compatibility version

Published release tags remain date based: `release-YYYY.MM.DD-N`. A publishable artifact derives one canonical semver-compatible runtime identity from that tag:

```text
release-2026.09.06-2 -> 2026.9.6-2
```

The year, month and day become the semantic-version core without zero padding, and the positive release sequence becomes the numeric prerelease component. This keeps supported release tags in release order: later sequences on the same date compare higher, and later dates compare higher than earlier dates.

Release qualification stamps that compatibility version into the artifact's `package.json` and root `package-lock.json`, then records the same tag/version pair in `manifest.json`. Runtime code therefore reads the actual installed artifact identity through the normal package metadata path; operators do not need to set `AGENT_BRIDGE_VERSION`. Explicit version injection and `AGENT_BRIDGE_VERSION` remain override paths for tests/development.

## Publish a release

First run the `Release Artifact` workflow manually from `main` and provide the intended `release_tag`. Manual release qualification requires the tag and binds it into the artifact. Automatic `main` push qualifications remain useful CI evidence, but are intentionally not publishable because they are not bound to a release identity.

After that run succeeds, run the `Publish GitHub Release` workflow from the repository Actions page on `main` and provide:

- `workflow_run_id`: the successful manual `Release Artifact` run for `main`;
- `commit_sha`: the exact lowercase 40-character commit qualified by that run;
- `release_tag`: the same new tag used for release qualification, such as `release-2026.09.07-1`.

The workflow requires the source run to be a successful `workflow_dispatch` qualification on `main`. It downloads the exact artifact named `agent-bridge-release-<commit-sha>`, without rebuilding it, and verifies:

- the source repository, workflow, branch, result and commit;
- the exact archive and checksum filenames;
- the archive SHA-256;
- safe archive member paths;
- manifest commit, tree, runtime and builder provenance;
- qualification evidence and required checks;
- the requested release tag maps to the embedded canonical compatibility version;
- `manifest.json`, `package.json` and the requested release tag all agree on that identity.

The requested release tag and GitHub Release must not already exist. Publication creates a draft release, uploads the unchanged `.tar.gz` and `.sha256` files, and publishes it only after both uploads succeed. A failed publication attempts to remove the draft and its newly created tag.

## Deployment boundary

Publishing a release makes a durable, versioned copy of a qualified artifact available. It does not change an active runtime.

- Direct-host deployment remains a separate, explicitly authorised `agent-bridge-deploy` operation.
- Platform provisioning and fleet rollout remain separate explicit operations that select a pinned release identity.
- The `Release Artifact` workflow still qualifies `main` pushes and manual runs; only a tag-bound manual run can be promoted to a GitHub Release.
