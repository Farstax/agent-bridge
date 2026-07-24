# Historical release artifact builder

This workflow is CI-only. It does not stage releases on a server, change the
`current` pointer, install helpers, clear rollout sentinels, or access
production secrets.

It deliberately separates two identities:

- `builder_commit` is the reviewed workflow and tooling source.
- `target_commit` plus `expected_tree` is the historical runtime source.

The builder checks both identities before running the target checkout's tests,
typecheck, Architecture Lint, build, and production dependency pruning. Runtime
files are copied only from the target checkout. Manifest and provenance files
are generated only by the trusted builder checkout.

Run only after independently reviewing the builder commit and target tree:

```bash
gh workflow run historical-release-artifact.yml \
  --repo nickconstantinou/agent-bridge \
  --ref main \
  -f target_commit=39580135024f2cca329e498f60b18e599ca145fd \
  -f expected_tree=6ec3849330d218f6b0a28aadfa295b5dda8d1992 \
  -f builder_commit=<reviewed-main-builder-commit>
```

The uploaded non-production artifact includes its archive checksum, tar member
listing (including Unix modes), manifest, and separately hashed provenance.
The provenance binds the target commit/tree, builder commit, workflow blob and
hash, manifest-tool hash, package-lock hash, runtime, archive hash, member-list
hash, full mode inventory, and executable entries.

Do not stage or deploy the artifact until the workflow run, archive, manifest,
and provenance have received independent review. A successful CI build is not
production activation authorization.
