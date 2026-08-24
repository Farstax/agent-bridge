# Provider contract qualification

Agent Bridge treats Codex, Claude, Agy, Grok Build, and Cursor as external CLI contracts. Provider qualification checks the observable process/session behaviour that Agent Bridge depends on; it is not a model-quality or coding benchmark.

## Contract v1

`agent_bridge_provider_contract: 1`

The initial live contract is deliberately small and incident-driven:

1. `version` — the installed executable starts and reports the expected version.
2. `fresh_prompt` — a bounded non-interactive prompt crosses the real Agent Bridge invocation/supervisor/parser boundary and returns the qualification marker.
3. `session_resume` — when the fresh result exposes an invocation-attributable session ID, a second bounded prompt resumes that session and returns the resume marker. Providers that do not expose such an ID report `not_applicable`.

Agy qualification uses its native JSON output mode even when normal runtime traffic is temporarily configured for the legacy text rollback path. This makes contradictory or malformed native envelopes visible during qualification. In particular, an Agy `ERROR` envelope carrying a non-empty `response` is a contract failure.

Check states are `pass`, `fail`, `not_applicable`, `unsupported`, and `not_authenticated`. A qualification record has `overall: pass|degraded|fail`. Authentication, capacity/model availability and transient upstream prerequisites are distinguished from deterministic contract failure rather than being collapsed into a boolean.

## When live qualification runs

Deterministic provider-boundary fixtures remain part of the ordinary test suite. Live qualification is not run on every service startup or every PR.

The managed production trigger is a CLI install/upgrade or a subsequently observed out-of-band version change:

- `scripts/upgrade.sh --clis-only` verifies the installed Claude/Codex versions and invokes the qualifier with `--if-needed`.
- Qualification evidence is cached by provider version and Agent Bridge provider-contract version, so an already-qualified tuple is not re-run.
- The health service checks established evidence for out-of-band/self-updated provider versions. When `installed_version != last_qualified_version`, it qualifies that provider once and persists the new result.
- Only the changed provider is qualified.

Grok and Cursor are not part of the managed automatic upgrade set. Their qualifiers can be run explicitly after installation, an upgrade, or when troubleshooting:

```bash
npm run qualify:provider -- --provider grok
npm run qualify:provider -- --provider cursor
```

Qualification is diagnostic rather than a positive routing prerequisite. An authenticated Grok or Cursor install can participate when explicitly selected/configured without a prior `pass` record. Cursor remains opt-in and is not part of the default interactive chain. A current deterministic `overall: fail` record for the installed provider version suppresses routing until the failure is resolved or the binary version changes.

Cursor Skills use the canonical managed projection `~/.cursor/skills/<name>/SKILL.md`. Managed skill install does not auto-project into Cursor alongside Claude/Codex. Explicit Cursor projection is available through `npm run skills -- project-cursor <name>` or `install`/`project-user --project-cursor`, and refuses to overwrite unmanaged Cursor skill paths. Cursor may still discover Claude/Codex skill directories; duplicate skill names across those paths are ambiguous and were observed to prefer the Claude-compatible copy during #552.

Cursor `safe` execution uses `--mode ask --trust` (read-only Ask contract). Cursor `trusted` execution uses `--trust --sandbox disabled`. Auth readiness uses only `cursor-agent status --format json`; credential files and API keys are not Agent Bridge authentication evidence for Cursor.

No separate qualification scheduler is installed.

## Evidence

The default evidence file is:

```text
~/.agent-bridge/provider-qualification.json
```

It can be overridden with `AGENT_BRIDGE_PROVIDER_QUALIFICATION_PATH`.

Each provider record includes the provider/version, prior version when known, Agent Bridge commit/release identity, contract version, UTC timestamp, environment class, overall result, and bounded per-check diagnostics. The file is written atomically with mode `0600`; its parent directory is created with mode `0700`.

Run an explicit qualification with:

```bash
npm run qualify:provider -- --provider codex
npm run qualify:provider -- --provider claude
npm run qualify:provider -- --provider agy
npm run qualify:provider -- --provider grok
npm run qualify:provider -- --provider cursor
```

`--expected-version <version>` and `--if-needed` are available for managed upgrade paths. Machine-readable JSON is written to stdout. A deterministic contract failure exits non-zero after persisting its evidence; a degraded prerequisite state remains distinguishable in the JSON result.

## Surfacing failures

Managed upgrade output is consumed by the health auto-remediation path. A newly qualified `fail` or `degraded` result produces one health notification for that upgrade/version-change event. The evidence cache prevents the same version from being repeatedly qualified and re-alerted on every health cadence.

On-demand `/health` and `/status` include the persistent qualification summary without adding the qualification record as a scheduled health plugin, avoiding repeated Telegram reports for the same known degraded version. `npm run doctor` prints the same concise qualification summary. Detailed per-check diagnostics remain in the evidence file.

The runtime does not automatically downgrade a failed CLI. For all providers, current deterministic `overall: fail` evidence excludes that provider from interactive selection and fallback chains while missing, stale, or `degraded` prerequisite/transient evidence remains visible but routeable.

## Regression policy

When a production provider incident exposes a reusable assumption at the CLI boundary, add or update a deterministic qualification fixture when practical. Prefer a small corpus of high-signal process/session regressions over a broad capability matrix.

## Explicit non-goals

This qualification mechanism does not:

- benchmark model intelligence or answer quality;
- maintain a permanent provider-version allowlist;
- gate every release on live external calls;
- require a positive qualification record before normal routing;
- dynamically rewrite provider capabilities from model judgement;
- add a separate timer/scheduler;
- automatically roll back/downgrade provider packages after a qualification failure.
