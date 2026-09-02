# Adding a CLI provider

Agent Bridge coordinates native coding-agent CLIs. A provider integration should preserve that boundary: the provider owns native reasoning, tools, sessions, and provider-specific protocol; Agent Bridge owns durable Run identity, routing/fallback, process lifecycle, cancellation/fencing, delivery, and other cross-provider safety concerns.

This guide describes the current integration path. It intentionally does **not** introduce a plugin framework or make provider addition a one-file operation.

## Decide the integration depth first

Keep three concerns separate:

1. **Provider CLI contract** — Agent Bridge can describe the provider, construct an invocation, execute it through the shared supervisor, parse the result, classify important failures, and test the observable contract.
2. **Ordinary Bridge routing and surfaces** — the provider can actually be selected by normal Runs, configured by Bridge, participate in fallback, and optionally receive a dedicated provider-locked service or surface.
3. **Managed lifecycle** — Agent Bridge installation/upgrade tooling installs, pins, authenticates, checks, or automatically qualifies the CLI.

An integration can start with the CLI contract without making Agent Bridge manage installation or creating a dedicated service. However, a provider that should participate in ordinary Bridge Runs must also be represented in the current closed Bridge routing/configuration types.

## Architecture boundaries

```text
Bridge Run / routing
        |
        v
src/cli.ts
  common orchestration + explicit provider dispatch
        |
        +--> src/providers/<provider>Runtime.ts
        |      provider-specific argv/stdin and output parsing
        |
        v
src/cliSupervisor.ts
  shared spawn / env / lock / timeout / cancellation / redaction / settlement
        |
        v
native provider executable
```

`src/cliSupervisor.ts` is the authoritative child-process lifecycle. New providers should normally use it unchanged. Provider command construction, result parsing, session protocol, and provider-specific completion semantics belong in the provider runtime, not the supervisor.

The shared provider contracts live in `src/providers/types.ts`:

- `PROVIDER_IDS` / `ProviderId` — canonical provider identity;
- `ProviderAdapter` — executable/version metadata, capabilities, and optional process watch;
- `ProviderCapabilities` — cross-provider capability metadata;
- `ProviderInvocationRequest` — common inputs to provider invocation builders;
- `ProviderInvocation` — command, arguments/stdin, and native session mode returned by a provider runtime.

`ProviderAdapter` is currently metadata-oriented. Invocation construction and output parsing are not registered polymorphically; `src/cli.ts` explicitly dispatches to provider runtime modules.

## 1. Add provider identity and registry metadata

Add the canonical provider identifier to `PROVIDER_IDS` in `src/providers/types.ts`; `ProviderId` is derived from that list.

Add the corresponding entry to `src/providers/registry.ts` with:

- `id`;
- `displayName`;
- default executable;
- `versionArgs`;
- `defaultArgs` where applicable;
- `interactive`, `fallbackTarget`, and `toolFree` capabilities;
- `processWatch` only when the provider exposes a provider-specific process failure signal that ordinary process settlement cannot represent.

Keep capabilities factual and deterministic. Do not infer them from model responses.

If Bridge-facing vocabulary differs from the canonical provider ID, update the mapping deliberately. Agy is the existing example: its provider ID is `agy`, while Bridge surface vocabulary uses `antigravity`.

Adding a `ProviderId` also widens exhaustive provider records. Inspect compiler failures and existing `Record<ProviderId, ...>` structures rather than adding a default branch that hides missing provider behavior. One current example is `CAPACITY_PATTERNS` in `src/providers/errorClassification.ts`.

## 2. Add the provider runtime

Create `src/providers/<provider>Runtime.ts`, following existing modules such as `grokRuntime.ts`, `codexRuntime.ts`, or `claudeRuntime.ts`.

The normal boundary is:

```ts
import type { CliResult } from "../types.js";
import type {
  ProviderInvocation,
  ProviderInvocationRequest,
} from "./types.js";

export function buildInvocation(
  request: ProviderInvocationRequest,
): ProviderInvocation {
  return {
    command: request.command,
    args: [/* provider-native arguments */],
    nativeSessionMode: request.sessionId ? "resume" : "fresh",
  };
}

export function parseResult(stdout: string): CliResult {
  // Validate the provider's real observable output contract and fail closed
  // on malformed or contradictory terminal evidence.
  throw new Error("implement provider parser");
}
```

The provider runtime owns applicable behavior such as:

- prompt placement and response-contract wrapping requirements;
- structured-output flags;
- model and effort flags;
- safe versus trusted execution flags;
- fresh versus resumed session arguments;
- attachment support or explicit rejection;
- provider-native completion/session evidence;
- parsing structured output and terminal events;
- rejecting malformed or contradictory successful output.

Prefer a machine-readable native output mode when the CLI provides one. Do not spawn the process from the provider runtime. Return a `ProviderInvocation`; shared process execution remains in `cliSupervisor.ts`.

## 3. Wire invocation and parsing through `src/cli.ts`

Import the runtime into `src/cli.ts` and extend both explicit dispatch points:

- `buildCliInvocation()` calls the provider's `buildInvocation()`;
- `parseCliResult()` calls the provider's `parseResult()`.

Keep `runCli()` / `runCliAsync()` on the shared `runSupervisedProcess()` path.

The explicit dispatch is current architecture. Do not turn a provider-addition change into a plugin-system refactor unless a separate accepted change establishes concrete duplication or failure evidence that justifies it.

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
  + executable/version/capability metadata

src/providers/exampleRuntime.ts
  + buildInvocation(request)
  + parseResult(stdout)

src/cli.ts
  + invocation dispatch
  + parse dispatch

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

- [ ] Confirm the native CLI exposes a usable headless/non-interactive contract.
- [ ] Add `ProviderId` and registry metadata/capabilities.
- [ ] Resolve exhaustive `ProviderId` records, including error classification.
- [ ] Add a provider runtime with invocation construction and fail-closed parsing.
- [ ] Wire invocation and parsing through `src/cli.ts`.
- [ ] Keep execution on the shared `cliSupervisor.ts` path.
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
