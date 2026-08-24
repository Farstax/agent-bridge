# Provider API-key authentication

Agent Bridge supports provider-owned API-key authentication without creating a separate routing, session, or execution path. Account/OAuth authentication remains supported.

| Provider | Environment variable | Native verification | Runtime notes |
| --- | --- | --- | --- |
| Codex | `CODEX_API_KEY` | bounded `codex exec` turn | `OPENAI_API_KEY` is not the Agent Bridge Codex exec contract |
| Claude Code | `ANTHROPIC_API_KEY` | bounded `claude --print` turn | local auth-status output is not treated as proof that a request will succeed |
| Agy / Antigravity | `GEMINI_API_KEY` | bounded Agy print-mode turn | requires `modelProvider: "gemini"`; Bridge scopes that setting to the run and restores the prior value |
| Grok Build | `XAI_API_KEY` | bounded `grok -p` turn | stored account session remains the provider-preferred route when present |
| Cursor Agent | `CURSOR_API_KEY` | bounded `cursor-agent -p` turn | account sessions continue to use native status detection |

The matrix is an exhaustive `Record<ProviderId, ...>` in `src/providers/apiKeyAuth.ts`. Adding a new provider therefore fails type-check until its API-key capability is classified.

## Verification contract

A non-empty environment variable is only a candidate credential. Agent Bridge makes the provider selectable through API-key auth only after that provider's CLI completes a real headless request within 15 seconds.

Verification runs with isolated account state so a cached OAuth/account session cannot make an invalid API key look valid. Telegram secrets and unrelated provider credentials are removed from the verification child environment. API keys stay in environment variables and are never placed in process arguments.

Successful verification is cached for 10 minutes by a SHA-256 fingerprint of the key. Failed verification is cached for 30 seconds. The raw key is never stored in the cache.

## Routing and qualification

Authentication method does not create a new provider identity. A provider authenticated by API key uses the same selection, fallback, qualification, session, execution-mode, and completion contracts as the same provider authenticated through its existing account flow. Current deterministic qualification failures still suppress routing.

Grok Build is the one precedence exception inherited from the provider: when a stored Grok account session exists, Agent Bridge keeps that account path and does not require `XAI_API_KEY` verification. This matches Grok Build's account-session-before-environment-key behavior.

## Agy settings

Agy's direct Gemini API route requires both `GEMINI_API_KEY` and `modelProvider: "gemini"`. Verification uses an isolated temporary home. Real Agent Bridge runs apply `modelProvider: "gemini"` only while holding the existing Agy state lock, then restore the prior provider setting in `finally`. Existing model-setting behavior remains under the same lock.

## Secret boundary

The shared CLI supervisor redacts configured provider credential values before stdout/stderr, progress chunks, lifecycle events, spawn logs, or returned errors leave the process boundary. Internal raw output is retained only long enough for provider validation and process-watch logic.

Agent Bridge OSS does not persist provider API keys and exposes no app-facing secret state. Encrypted persistence and onboarding/UI belong to `agent-bridge-platform#482`.

## Upstream contracts

- Codex: `CODEX_API_KEY` is the non-interactive `codex exec` API-key environment contract; Codex auth state lives under `CODEX_HOME`.
- Claude Code: `ANTHROPIC_API_KEY` is supported for print/headless use; request success, not local status alone, is the usability gate.
- Agy: Antigravity CLI 1.1.13 added `GEMINI_API_KEY` direct API support with `modelProvider: "gemini"`.
- Grok Build: xAI documents `XAI_API_KEY` for headless operation and account-session precedence over the environment fallback.
- Cursor: Cursor documents `CURSOR_API_KEY` for headless/CI authentication.
