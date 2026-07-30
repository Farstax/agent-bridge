# GitHub Releases

Agent Bridge GitHub Releases are published only through an explicit promotion of an already-qualified `Release Artifact` workflow run. Release publication does not rebuild the runtime and does not deploy it.

## Publish a release

Run the `Publish GitHub Release` workflow from the repository Actions page on `main` and provide:

- `workflow_run_id`: a successful `Release Artifact` run for `main`;
- `commit_sha`: the exact lowercase 40-character commit qualified by that run;
- `release_tag`: a new tag such as `release-2026.07.30-1`.

The workflow requires the source run to be a successful `push` or `workflow_dispatch` qualification on `main`. It downloads the exact artifact named `agent-bridge-release-<commit-sha>`, without rebuilding it, and verifies:

- archive and checksum filenames;
- archive SHA-256;
- safe and unambiguous archive members;
- manifest commit, tree, runtime and builder provenance;
- qualification evidence and required checks;
- every manifest-declared file hash, size and symlink target.

The requested release tag and GitHub Release must not already exist. Publication creates a draft release, uploads the unchanged `.tar.gz` and `.sha256` files, and publishes it only after both uploads succeed. A failed publication attempts to remove the draft and its newly created tag.

## Deployment boundary

Publishing a release makes a durable, versioned copy of a qualified artifact available. It does not change an active runtime.

- Direct-host deployment remains a separate, explicitly authorised `agent-bridge-deploy` operation.
- Platform provisioning and fleet rollout remain separate explicit operations that select a pinned release identity.
- The existing `Release Artifact` workflow continues to qualify pull requests, `main` pushes and manual runs independently of release publication.
