# Adding a provider

Agent Bridge uses ACP v1 as the canonical inward provider contract. The
provider owns reasoning, tools, and native session state; ACP owns agent
communication; Agent Bridge owns durable Run identity, routing/fallback,
process lifecycle, cancellation/fencing, delivery, and other cross-provider
safety concerns.

The normal onboarding unit is a Registry identity plus release pin and a small
policy entry. A provider-specific runtime/parser is only for a provider that
has not adopted ACP; do not create one for a Registry-listed ACP agent.

## Decide the integration depth first

Keep three concerns separate:

1. **ACP contract** — the Registry-listed agent is release-pinned and qualified through the shared ACP runtime.
2. **Ordinary Bridge routing and surfaces** — the provider can actually be selected by normal Runs, configured by Bridge, participate in fallback, and optionally receive a dedicated provider-locked service or surface.
3. **Managed lifecycle** — Agent Bridge installation/upgrade tooling installs, pins, authenticates, checks, or qualifies the selected agent distribution.

A provider that should participate in ordinary Bridge Runs must be represented
in the current closed Bridge routing/configuration types. Installation and a
dedicated service remain separate product decisions.

## Architecture boundaries

```text
Bridge Run / routing
        |
        v
release-locked ACP Registry entry
        +
src/providers/<provider>AcpPolicy.ts
  provider-specific auth/authority/config/presentation only
        |
        v
src/providers/acpRuntime.ts + src/acp/
  generic launch/session/replay/cancel/result plumbing
        |
        v
src/cliSupervisor.ts
  shared process supervision and fencing
```

`src/providers/acpRuntime.ts` and `src/acp/` are the authoritative ACP lifecycle.
`src/cliSupervisor.ts` remains the authoritative child-process lifecycle. Use
both unchanged for an ordinary ACP provider. See [ACP.md](ACP.md) for the full
ownership and session-identity contract.

The shared provider contracts live in `src/providers/types.ts`:

- `PROVIDER_IDS` / `ProviderId` — canonical provider identity;
- `ProviderAdapter` — presentation/routing metadata, plus native launch metadata only for non-ACP providers;
- `ProviderCapabilities` — routing capabilities, plus native-only capabilities where applicable;
- `ProviderInvocationRequest` — common inputs to provider invocation builders;
- `ProviderInvocation` — the shared process invocation shape used by ACP and remaining native providers.

For ACP providers, distribution/version/launch authority comes from the
release-locked Registry entry and `AcpProviderPolicy`, not duplicated adapter
fields or `src/cli.ts` branches.

## 1. Add provider identity and registry metadata

Add the canonical provider identifier to `PROVIDER_IDS` in `src/providers/types.ts`; `ProviderId` is derived from that list.

Add the corresponding presentation/routing entry to `src/providers/registry.ts` with:

- `id`;
- `displayName`;
- `interactive` and `fallbackTarget` capabilities.

Do not add `executable`, `versionArgs`, `defaultArgs`, or native `toolFree`
metadata for an ACP provider. Those facts come from its locked Registry entry
and ACP policy. Native-only metadata remains required for an explicitly
non-ACP provider.

Keep capabilities factual and deterministic. Do not infer them from model responses.

If Bridge-facing vocabulary differs from the canonical provider ID, update the mapping deliberately. Agy is the existing example: its provider ID is `agy`, while Bridge surface vocabulary uses `antigravity`.

Adding a `ProviderId` also widens exhaustive provider records. Inspect compiler failures and existing `Record<ProviderId, ...>` structures rather than adding a default branch that hides missing provider behavior. One current example is `CAPACITY_PATTERNS` in `src/providers/errorClassification.ts`.

## 2. Lock the ACP distribution and add policy only where needed

Add the provider-to-agent mapping and exact qualified distribution/version to
the release-owned ACP Registry lock. Then register an `AcpProviderPolicy` in
`src/providers/registry.ts`.

The smallest policy contains only identity and presentation:

```ts
export const exampleAcpPolicy: AcpProviderPolicy = {
  providerId: "example",
  registryAgentId: "example-agent",
  presentation: { provisionalAnswers: false },
};
```

Add hooks only for differences ACP or the Registry cannot standardize enough,
such as auth preparation, Bridge authority/mode mapping, session configuration,
credential-safe child environment policy, error classification, or
presentation. Qualification must exercise the exact release-selected runtime.

If the agent is absent from the public Registry, a release may provide a narrow
launch override that still feeds `acpRuntime.ts`. Do not create a parallel
extension or mutable-latest resolution path.

## 3. Native fallback for a provider without ACP

Use this path only when the provider has not migrated to ACP and its migration
issue explicitly leaves native execution in scope. Add native launch metadata
to `ProviderAdapter`, implement a focused `<provider>Runtime.ts` for
argv/stdin/result parsing, and wire its build/parse dispatch through
`src/cli.ts`.

The native runtime may own:

- prompt placement and structured-output flags;
- model, effort, permission, and fresh/resume argv;
- attachment support or explicit rejection;
- provider-native completion/session evidence;
- strict parsing of machine-readable terminal output.

Do not put process supervision in the provider module. Keep it on
`cliSupervisor.ts`, and remove the native metadata/runtime/dispatch when that
provider later completes ACP migration and its rollback window closes.

## 4. Make it routeable through ordinary Bridge Runs when required

`ProviderId` and Bridge runtime vocabulary are separate today. If the provider should be selectable by normal Runs, extend the current closed Bridge types/configuration as required, including:

- `BotKind` in `src/types.ts`;
- `BridgeConfig.bots`;
- `loadBotsConfig()` in `src/config.ts`;
- command/model-preference environment handling;
- timeout/configuration records that are exhaustive over `BotKind`;
- interactive-chain and provider-lock parsing/validation where the new kind should be accepted;
- provider-ID/BotKind translation where the names differ.

Run `npm run typecheck` early after widening `ProviderId` or `BotKind`; exhaustive records are intentionally useful signals for integration points that otherwise drift.

### Dedicated surfaces and services are optional

Do **not** create a dedicated Telegram bot, environment file, or systemd unit merely because a provider exists.

A routeable provider may participate through the shared interactive service. Add dedicated surface/service configuration only when the product requires a separately locked provider surface. Existing providers demonstrate both patterns.

Update `.env.*.example` and Telegram/Discord presentation only for configuration or choices actually exposed to users/operators.

## 5. Define authentication, readiness, and error classification

Choose one authoritative readiness signal for the provider.

Prefer the provider CLI's own status/auth command when available. Do not treat the presence of a credential file or environment variable as authenticated runtime evidence unless that is the provider's supported contract.

Trace `src/providers/errorClassification.ts` and related fallback eligibility when the provider has recognizable authentication, capacity, unavailable-model, transient, or fatal failure signals. Because some provider classifications are exhaustive over `ProviderId`, a new provider normally requires an explicit classification entry even if its initial provider-specific pattern list is empty.

Keep secrets out of command arguments, logs, diagnostics, and persisted qualification evidence. The shared supervisor owns environment scrubbing and output redaction; extend those protections only for a genuinely new secret class.

If a provider-specific API key must reach the child process, extend the existing credential verification/filtering path narrowly rather than bypassing it.

## 6. Decide fallback participation explicitly

A provider being executable does not automatically make it a fallback target.

Set `fallbackTarget` in the registry to match actual routing policy, then update configured/default chains only when the provider should participate. Add deterministic coverage for:

- provider selection;
- fallback eligibility;
- transition to/from the provider;
- continuation/session behavior across the transition where applicable.

Do not make unknown/fatal provider errors eligible merely to increase fallback frequency.

## 7. Decide who owns installation and upgrades

Support for an already-installed CLI can be complete without Agent Bridge managing that CLI's installation.

If Agent Bridge should manage it, inspect and extend the applicable lifecycle paths:

- source/development installation;
- production initial installation;
- CLI-only upgrade handling;
- executable path propagation into service configuration;
- runtime version discovery;
- authentication prerequisites;
- rollback and cleanup behavior.

Do not assume a new provider belongs in the managed automatic upgrade set. The current provider-qualification contract explicitly distinguishes automatically managed providers from providers installed/upgraded externally and qualified explicitly.

See [INITIAL-INSTALL.md](INITIAL-INSTALL.md) for production installation ownership.

## 8. Add deterministic provider-boundary tests

Tests should prove observable provider contracts rather than implementation shape.

Cover the applicable cases:

- fresh invocation arguments;
- resumed-session arguments and identity;
- safe/trusted translation;
- model and effort translation;
- attachment behavior;
- structured output parsing;
- successful terminal evidence;
- malformed output;
- provider-reported failure despite process exit success;
- missing or contradictory completion evidence;
- auth/readiness parsing;
- error classification;
- selection/fallback eligibility when routeable.

Use production-shaped fixtures from the real CLI protocol where practical, while keeping ordinary tests deterministic and independent of credentials/network access.

The shared supervisor already owns lifecycle, timeout, cancellation, redaction, and parity tests. Add supervisor coverage only when the new provider reveals a new **cross-provider** lifecycle invariant.

## 9. Extend live qualification when Bridge depends on the provider contract

The command wrapper in `scripts/provider-qualification.ts` is generic: it validates `--provider` through the provider registry and delegates to the qualification implementation.

Provider contract logic lives in `src/providers/qualification.ts` and uses the normal `buildCliInvocation()` / `parseCliResult()` / supervised execution boundaries. When adding a routeable provider:

- ensure provider-to-`BotKind` translation is correct, especially for aliases;
- extend qualification implementation only where the new provider needs provider-specific handling;
- add deterministic qualification fixtures for the contracts Bridge relies on;
- keep the live probe bounded, deterministic, and non-destructive.

The canonical contract, trigger rules, evidence cache, failure semantics, and operator commands are in [PROVIDER-QUALIFICATION.md](PROVIDER-QUALIFICATION.md). Do not duplicate that policy here.

The explicit command remains:

```bash
npm run qualify:provider -- --provider <provider>
```

Live qualification is not an ordinary PR-CI requirement. It runs when the actual provider runtime version or Agent Bridge provider contract changes, or when explicitly requested.

## Minimal integration map

For a hypothetical `example` provider, core CLI support normally touches:

```text
src/providers/types.ts
  + ProviderId

src/providers/registry.ts
  + presentation/routing metadata

release-owned ACP Registry lock
  + exact agent distribution/version

src/providers/exampleAcpPolicy.ts (only when defaults are insufficient)
  + auth/authority/config/environment/presentation policy

src/providers/errorClassification.ts
  + exhaustive provider classification entry

test/...
  + deterministic provider-boundary fixtures
```

To make it available to ordinary Bridge routing, also trace:

```text
src/types.ts
src/config.ts
routing / provider-lock / timeout records
provider-ID <-> BotKind mapping
src/providers/qualification.ts
```

Only add these when the product requires them:

```text
.env provider examples / dedicated bot surface
systemd dedicated service
managed installer / automatic CLI upgrade ownership
fallback-chain membership
```

## Contributor checklist

Before opening the PR:

- [ ] Confirm the agent exposes the required ACP v1 contract.
- [ ] Add `ProviderId` and presentation/routing metadata.
- [ ] Lock the exact qualified ACP Registry distribution/version.
- [ ] Add only the ACP policy hooks the provider actually needs.
- [ ] Resolve exhaustive `ProviderId` records, including error classification.
- [ ] Keep execution on the shared `cliSupervisor.ts` path.
- [ ] For an explicitly non-ACP provider only, add native launch metadata, a fail-closed runtime/parser, and `src/cli.ts` dispatch.
- [ ] If routeable, add `BotKind`, Bridge config, routing/provider-lock mappings, and exhaustive `BotKind` records.
- [ ] Add a dedicated surface/service only when independently required.
- [ ] Define authoritative authentication/readiness evidence.
- [ ] Decide explicitly whether the provider participates in fallback.
- [ ] Decide explicitly whether Agent Bridge owns installation/upgrades.
- [ ] Add deterministic provider and qualification regressions.
- [ ] Update relevant operator documentation/environment examples.
- [ ] Run focused tests while iterating.
- [ ] Run `npm run typecheck` after widening provider/bot unions.
- [ ] Run `npm run qualify:local` for the final local deterministic gate before relying on exact-head hosted CI.

If a real provider addition exposes repeated wiring that is materially harder to maintain, raise the abstraction change separately with that evidence. Do not widen a provider integration into speculative framework work.
