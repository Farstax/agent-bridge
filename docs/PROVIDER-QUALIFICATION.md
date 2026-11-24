# Provider contract qualification

Agent Bridge treats Codex, Claude, Agy, Grok Build, and Cursor as external CLI contracts. Provider qualification checks the observable process/session behaviour that Agent Bridge depends on; it is not a model-quality or coding benchmark.

## Contract v6

`agent_bridge_provider_contract: 6`

The initial live contract is deliberately small and incident-driven:

1. `version` — the installed executable starts and reports the expected version.
2. `fresh_prompt` — a bounded non-interactive prompt crosses the real Agent Bridge invocation/supervisor/parser boundary and returns the qualification marker.
3. `session_resume` — when the fresh result exposes an invocation-attributable session ID, a second bounded prompt resumes that session and returns the resume marker. Providers that do not expose such an ID report `not_applicable`.
4. `repository_grounding` — one fresh native-tool-enabled invocation runs in a disposable Git repository. A runtime-generated source fact lives only in implementation source and a separate runtime-generated marker lives only in repository instructions; neither is included in the prompt. The check passes only when the native provider returns both exact values.

Codex, Claude, Agy, Grok and Cursor qualify the **actual selected ACP runtime**
through Agent Bridge's invocation, stdio supervisor and ACP session path.
For example, Codex's version probe checks the selected `codex-acp` adapter
(`CODEX_ACP_COMMAND` or the release-bundled binary), not `codex --version`.
Agy runs the locked `antigravity-acp` adapter, not a native `stream-json`
parser. Cursor runs `cursor-agent acp` and selects ACP session modes
`ask` (safe/read-only) or `agent` (trusted); it does not use the old native
`--mode ... --trust` or `--sandbox disabled` flags in this path.

A qualification record is current only for the selected provider, observed
version, contract version, and resolved `executionRuntime` identity.
When captured, the candidate executable path and SHA-256 must still match.
A staged candidate's evidence does not qualify the active runtime. The exact
executed runtime, not package-manager metadata or an earlier native-CLI
qualification, is authoritative.

Check states are `pass`, `fail`, `not_applicable`, `unsupported`, `not_authenticated`, `capacity_exhausted`, `model_unavailable`, and `transient`. A qualification record has `overall: pass|degraded|fail`. Authentication, capacity/model availability and transient upstream prerequisites are distinguished from deterministic contract failure rather than being collapsed into a boolean.

## When live qualification runs

Deterministic provider-boundary fixtures remain part of the ordinary test suite. Live qualification is not run on every service startup or every PR. The repository-grounding check is a capability/contract probe, not a subjective answer-quality benchmark: it uses exact runtime-generated facts and local comparison, so it adds no model-as-judge call.

The managed production trigger is a CLI install/upgrade or a subsequently observed out-of-band version change:

- `scripts/upgrade.sh --clis-only` verifies the installed Claude/Codex versions and invokes the qualifier with `--if-needed`.
- Qualification evidence is cached by provider version and Agent Bridge provider-contract version, so an already-qualified tuple is not re-run.
- The health service checks established evidence for out-of-band/self-updated provider versions. When `installed_version != last_qualified_version`, it qualifies that provider once and persists the new result.
- Only the changed provider is qualified. A contract-version change invalidates earlier evidence; the next needed qualification checks the current contract, including repository grounding, and then reuses current evidence.

Grok and Cursor can also be qualified explicitly after installation, an upgrade, or when troubleshooting. Cursor's release-locked binary is converged by guarded release activation and `scripts/upgrade.sh --update`; `--clis-only` does not install or upgrade Cursor. Ordinary Runs never auto-update either provider:

```bash
npm run qualify:provider -- --provider grok
npm run qualify:provider -- --provider cursor
```

Qualification is diagnostic rather than a positive routing prerequisite. An authenticated Grok or Cursor install can participate without a prior `pass` record. Cursor is the final target in the default interactive fallback chain, but it is routeable only when `cursor-agent status --format json` reports authenticated and the selected ACP runtime is compatible. A current deterministic `overall: fail` record remains visible as qualification evidence without suppressing routing.

Cursor Skills use the canonical managed projection `~/.cursor/skills/<name>/SKILL.md`. Managed skill install does not auto-project into Cursor alongside Claude/Codex. Explicit Cursor projection is available through `npm run skills -- project-cursor <name>` or `install`/`project-user --project-cursor`, and refuses to overwrite unmanaged Cursor skill paths. Cursor may still discover Claude/Codex skill directories; duplicate skill names across those paths are ambiguous and were observed to prefer the Claude-compatible copy during #552.

Cursor's selected ACP adapter requests `ask` for safe execution and `agent` for trusted execution via session mode configuration. Runtime availability uses the provider's own authenticated status; cached account login is required before requesting ACP `cursor_login`, while candidate API-key authentication is verified separately.

No separate qualification scheduler is installed.

## Evidence

The default evidence file is:

```text
~/.agent-bridge/provider-qualification.json
```

It can be overridden with `AGENT_BRIDGE_PROVIDER_QUALIFICATION_PATH`.

Each provider record includes the provider/version, prior version when known, Agent Bridge commit/release identity, contract version, resolved runtime identity, UTC timestamp, environment class, overall result, and bounded per-check diagnostics. It also records candidate executable path/digest when available. The file is written atomically with mode `0600`; its parent directory is created with mode `0700`.

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

Qualification is diagnostic evidence for interactive routing. A current deterministic `overall: fail` remains visible to health, doctor, release, and upgrade owners, but does not by itself exclude an authenticated provider with direct runtime prerequisites satisfied. Runtime-auth degradation, missing executables, and provider-specific execution prerequisites remain interactive availability gates.

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
