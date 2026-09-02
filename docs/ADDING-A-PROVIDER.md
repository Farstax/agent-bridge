# Adding a CLI provider

Agent Bridge coordinates native coding-agent CLIs. A provider integration should preserve that boundary: the provider owns its native reasoning, tools, sessions, and provider-specific protocol; Agent Bridge owns durable Run identity, routing/fallback, process lifecycle, cancellation/fencing, delivery, and other cross-provider safety concerns.

This guide describes the current provider integration path. It intentionally does **not** introduce a plugin framework or make provider addition a one-file operation.

## Start by deciding the integration depth

There are three separate concerns. Do not widen the change beyond the depth the provider needs.

1. **Provider runtime support** — Agent Bridge can construct an invocation, execute the CLI through the shared supervisor, parse its result, and reason about its capabilities.
2. **Bridge surface/routing support** — the provider is selectable from interactive routing, has Bridge configuration, and may participate in fallback or a provider-locked service.
3. **Managed lifecycle support** — Agent Bridge installation/upgrade tooling installs, pins, authenticates, checks, or automatically qualifies the CLI.

A provider can require all three, but they are not the same contract. In particular, supporting an already-installed executable does not automatically mean the managed installer should own installation or upgrades for it.

## Architecture boundaries

The important layers are:

```text
Bridge Run / routing
        |
        v
src/cli.ts
  provider dispatch + common invocation orchestration
        |
        +--> src/providers/<provider>Runtime.ts
        |      provider-specific arguments and output parsing
        |
        v
src/cliSupervisor.ts
  shared spawn / env / lock / timeout / cancellation / redaction / settlement
        |
        v
native provider executable
```

`src/cliSupervisor.ts` is the single authoritative child-process lifecycle. New providers should normally use it unchanged. Do not add provider command construction, result parsing, or provider protocol decisions to the supervisor.

The shared provider contracts live in `src/providers/types.ts`:

- `ProviderId` — canonical provider identity used by the provider registry.
- `ProviderAdapter` — provider metadata, executable/version defaults, capabilities, and optional process watch.
- `ProviderInvocationRequest` — common inputs given to provider invocation builders.
- `ProviderInvocation` — the command/arguments/stdin/session-mode returned by a provider runtime.
- `ProviderCapabilities` — cross-provider capability metadata.

The current `ProviderAdapter` is deliberately **not** a complete polymorphic runtime adapter. Invocation construction and output parsing live in provider runtime modules and are explicitly dispatched from `src/cli.ts`.

## 1. Add the provider identity and registry metadata

Add the canonical provider identifier to `ProviderId` / `PROVIDER_IDS` in `src/providers/types.ts`.

Register the provider in `src/providers/registry.ts` with the metadata Agent Bridge needs to discover and reason about it:

- `id`;
- `displayName`;
- default executable;
- supported version arguments;
- default arguments, if any;
- `interactive`, `fallbackTarget`, and `toolFree` capability flags;
- `processWatch` only when the provider exposes a provider-specific process failure signal that cannot be represented by ordinary process settlement.

Keep registry capabilities factual and deterministic. Do not infer them from model responses.

If Bridge-facing vocabulary differs from the provider ID, update the registry mapping deliberately. Agy is the existing example: Bridge surface vocabulary uses `antigravity`, while the canonical provider ID is `agy`.

## 2. Add a provider runtime

Create `src/providers/<provider>Runtime.ts` following the existing runtime modules such as `grokRuntime.ts`, `codexRuntime.ts`, or `claudeRuntime.ts`.

The normal shape is:

```ts
import type { CliResult } from "../types.js";
import type {
  ProviderInvocation,
  ProviderInvocationRequest,
} from "./types.js";

export function buildInvocation(
  request: ProviderInvocationRequest,
): ProviderInvocation {
  // Translate the common request into this CLI's native argv/stdin contract.
  return {
    command: request.command,
    args: [/* provider-native arguments */],
    nativeSessionMode: request.sessionId ? "resume" : "fresh",
  };
}

export function parseResult(stdout: string): CliResult {
  // Parse and validate the provider's observable output contract.
  // Fail closed on malformed or contradictory terminal evidence.
  return { text: stdout, sessionId: null };
}
```

The runtime owns provider-specific behavior such as:

- prompt placement;
- structured-output flags;
- model/effort flags;
- safe versus trusted execution flags;
- fresh versus resumed session arguments;
- attachment support or explicit rejection;
- provider-native completion/session evidence;
- parsing structured output and terminal events;
- classifying malformed or contradictory successful output as failure.

Prefer a structured native output mode when the CLI provides one. Parse observable provider contracts rather than scraping human-oriented terminal text when a machine-readable protocol exists.

Do not spawn the process directly from the provider runtime. Return a `ProviderInvocation`; the shared supervisor owns process execution.

## 3. Wire the runtime into `src/cli.ts`

`src/cli.ts` is the current orchestration seam. Import the new provider runtime and extend the explicit provider dispatch in both directions:

- `buildCliInvocation()` must call the provider's `buildInvocation()`;
- `parseCliResult()` must call the provider's `parseResult()`.

This explicit dispatch is intentional current architecture. Do not replace it with a new plugin system as part of adding one provider unless a separately accepted change establishes a concrete need for that abstraction.

The shared `runCli()` / `runCliAsync()` path should continue to delegate process execution to `runSupervisedProcess()` in `src/cliSupervisor.ts`.

## 4. Add Bridge surface/configuration wiring only when needed

Provider runtime support and user-facing surface support are related but distinct.

If the provider must be selectable or locked as a Bridge bot/provider, update the relevant closed Bridge types and configuration, currently including:

- `BotKind` in `src/types.ts`;
- the `BridgeConfig.bots` shape;
- `loadBotsConfig()` in `src/config.ts`;
- provider command/model preference environment handling;
- interactive chain/provider-lock parsing and validation where the new kind should be accepted;
- relevant `.env.*.example` files;
- Telegram/Discord presentation only where provider-specific naming or choices are exposed.

Do not create a dedicated service merely because a provider exists. Existing providers demonstrate both patterns: some have established provider-locked units, while others participate through the shared interactive service.

When adding fallback participation, decide explicitly whether the provider may be a fallback target and where it belongs in configured/default chains. `fallbackTarget` in the provider registry should agree with actual routing policy.

## 5. Define authentication and readiness

Document and implement one authoritative readiness signal for the provider.

Prefer the provider CLI's own status/auth command when available. Avoid treating the mere presence of a credential file or environment variable as authenticated runtime evidence unless that is the provider's actual supported contract.

Keep secrets out of command arguments, logs, diagnostics, and persisted qualification evidence. The shared supervisor already owns environment scrubbing and output redaction; extend those shared protections only when the new provider exposes a genuinely new secret class.

If provider-specific API keys must be admitted to the child environment, trace the existing credential-verification/filtering path and add the narrowest required support.

## 6. Decide who owns installation and upgrades

An integration may stop at support for an already-installed executable.

If Agent Bridge will also manage the CLI, inspect and update the installation/upgrade paths deliberately, including as applicable:

- source/development installation;
- production initial installation;
- CLI-only upgrade handling;
- executable path propagation into service configuration;
- version discovery;
- authentication prerequisites;
- rollback/cleanup behavior.

Do not assume a new provider belongs in the managed automatic upgrade set. For example, the provider-qualification documentation distinguishes managed automatic upgrade providers from providers that are installed/upgraded externally and qualified explicitly.

Production installation architecture is documented in [INITIAL-INSTALL.md](INITIAL-INSTALL.md).

## 7. Add deterministic provider-boundary tests

Tests should prove the observable provider contract, not implementation shape.

At minimum cover the provider-specific behavior that applies:

- fresh invocation arguments;
- resumed-session arguments and identity;
- safe/trusted mode translation;
- model and effort translation;
- attachment behavior;
- structured output parsing;
- successful terminal evidence;
- malformed output;
- provider-reported failure despite process exit success;
- missing/contradictory completion evidence;
- auth/readiness parsing;
- fallback/routing eligibility when added to routing.

Use production-shaped fixtures captured from the real CLI contract where practical, but keep ordinary tests deterministic and credential/network independent.

The shared supervisor already has lifecycle, timeout, cancellation, redaction, and parity coverage. Add supervisor tests only if the provider reveals a new **cross-provider** lifecycle invariant; do not duplicate supervisor coverage in every provider test.

## 8. Extend live qualification when Agent Bridge depends on the provider contract

Agent Bridge treats provider CLIs as external contracts. If the new provider is supported by normal routing, extend `scripts/provider-qualification.ts` and its deterministic qualification fixtures so the contracts Agent Bridge relies on can be checked against the real executable.

The live qualification contract, trigger rules, evidence cache, failure semantics, and commands are canonical in [PROVIDER-QUALIFICATION.md](PROVIDER-QUALIFICATION.md). Reference that document rather than creating provider-specific qualification policy.

The normal explicit form is:

```bash
npm run qualify:provider -- --provider <provider>
```

Live qualification is not an ordinary PR-CI requirement. It is used when the actual provider runtime version or Agent Bridge provider contract changes, or when explicitly requested.

## Minimal integration example

For a hypothetical `example` CLI, the smallest provider-runtime slice is conceptually:

```text
src/providers/types.ts
  + "example" ProviderId

src/providers/registry.ts
  + executable/version/capability metadata

src/providers/exampleRuntime.ts
  + buildInvocation(request)
  + parseResult(stdout)

src/cli.ts
  + build dispatch
  + parse dispatch

test/...
  + deterministic invocation/parser contract fixtures

scripts/provider-qualification.ts
  + qualification support when the provider is routeable/supported
```

Only add the following when the product requires them:

```text
src/types.ts / src/config.ts / .env examples
  + Bridge surface and configuration vocabulary

routing/fallback configuration
  + selection and fallback participation

installer/upgrade scripts
  + managed CLI lifecycle
```

The key rule is that provider-specific argv/protocol logic belongs in the provider runtime, while shared process lifecycle remains in `cliSupervisor.ts`.

## Contributor checklist

Before opening the PR:

- [ ] Confirm the native CLI can provide the required headless/non-interactive contract.
- [ ] Add `ProviderId` and registry metadata/capabilities.
- [ ] Add a provider runtime with invocation construction and fail-closed parsing.
- [ ] Wire build/parse dispatch through `src/cli.ts`.
- [ ] Keep process execution on the shared `cliSupervisor.ts` path.
- [ ] Add `BotKind`/configuration/surface wiring only if the provider is exposed there.
- [ ] Define authoritative authentication/readiness evidence.
- [ ] Decide explicitly whether install/upgrade ownership belongs to Agent Bridge.
- [ ] Decide explicitly whether the provider participates in fallback/routing.
- [ ] Add deterministic provider-boundary regression tests.
- [ ] Add/extend live provider qualification when Agent Bridge depends on the external CLI contract.
- [ ] Update relevant user/operator documentation and environment examples.
- [ ] Run focused tests while iterating, then `npm run qualify:local` before relying on exact-head hosted CI.

If adding a provider exposes repeated wiring that is materially harder to maintain, raise that as a separate abstraction change with concrete duplication/failure evidence. Do not widen a provider-addition PR into speculative provider-framework work.