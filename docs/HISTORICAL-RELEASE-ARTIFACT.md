# Historical release artifact builder

This workflow is CI-only. It does not stage releases on a server, change the
`current` pointer, install helpers, clear rollout sentinels, or access
production secrets.

It deliberately separates two identities:

- `builder_commit` is the reviewed workflow and tooling source.
- `target_commit` plus `expected_tree` is the historical runtime source.

Target execution and trusted proving run as two separate jobs on separate
runners, connected only by an opaque uploaded/downloaded materials artifact:

- `build-target` checks out only the target commit, verifies its identity and
  tree, then runs its tests, typecheck, Architecture Lint, build (if any —
  see build strategies below), and production dependency pruning. It
  re-verifies tracked source (`src`, the rollout scripts, `package.json`,
  `package-lock.json`) is unchanged from `HEAD` immediately before packaging,
  so a malicious or buggy target-controlled script can't rewrite tracked
  source after identity verification and still ship under the original
  commit's name. This job never checks out the trusted builder and never runs
  `releaseManifest.mjs` or `releaseProvenance.mjs`.
- `prove` checks out only the trusted builder commit (required to equal
  `github.workflow_sha`, the commit GitHub actually executed this workflow
  from), downloads the opaque materials artifact, and runs only trusted
  tooling: `releaseManifest.mjs` to build the manifest, `tar` to assemble the
  archive, and `releaseProvenance.mjs` to verify the archive and generate
  provenance. It extracts the completed, already-hashed archive into a fresh
  verify root and checks every manifest-recorded file's real bytes/size and
  every symlink's real target against it — not text parsed from `tar --list`,
  which cannot see real content and has repeatedly drifted from tar's actual
  output format (missing `./` prefixes, dropped hardlink entries).

## Build strategies

Not every historical commit has a compile step. `releaseManifest.mjs` derives
the strategy from the packaged `package.json` itself (never from a flag the
untrusted `build-target` job reports) and validates the packaged files match:

- **`compiled`** — `package.json` has a `scripts.build` entry. Requires a
  non-empty `dist/` in the packaged artifact.
- **`source-tsx`** — no `scripts.build` entry. Requires `tsx` as a production
  dependency, the `tsx` runtime CLI (`node_modules/tsx/dist/cli.mjs`), every
  canonical `src/index*.ts` runtime entrypoint, and rejects any `dist/`
  present (an artifact can't ambiguously claim both strategies).

`39580135024f2cca329e498f60b18e599ca145fd` predates the build script and runs
directly from source via `tsx` — its systemd runtime launches
`node_modules/tsx/dist/cli.mjs` against `src/index-interactive.ts` and
`src/index-worker.ts`. `source-tsx` packaging reproduces that actual service
execution contract rather than inventing a compilation step that never
existed for this baseline. `build_strategy` is recorded in both the manifest
and provenance.

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
hash, manifest-tool hash, package-lock hash, build strategy, runtime, archive
hash, member-list hash, full mode inventory, and executable entries.

Do not stage or deploy the artifact until the workflow run, archive, manifest,
and provenance have received independent review. A successful CI build is not
production activation authorization.
