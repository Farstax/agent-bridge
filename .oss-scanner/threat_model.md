# Agent Bridge: OSS Scanner threat model

## Project and scope

Agent Bridge is an Apache-2.0-licensed, self-hosted Node.js/TypeScript runtime that
connects provider-native coding agents to Telegram and Discord and preserves
conversations, sessions, scheduled runs, artifacts, and durable recovery across
restarts. Some authorized coding-agent operations can execute tools and shell
commands using the local machine's permissions.

Scan https://github.com/Farstax/agent-bridge, including runtime code, ingress,
provider adapters, SQLite state and migrations, installer/deployment scripts,
credential handling, and operator/diagnostic tools. The proprietary Farstax
Platform and its managed-hosting control plane are separate and out of scope.
Do not treat vulnerabilities in third-party packages as Agent Bridge findings
unless the repository exposes or mishandles them in a reachable way.

## Trust boundaries and adversarial inputs

- Telegram/Discord messages, attachments, callback metadata, identity IDs,
  routing information, and bot or webhook events, including messages from
  unauthorized actors and events replayed, reordered, or forged.
- Provider ACP/native protocol output, model-generated text, tool results,
  subprocess output, and malformed or interrupted event streams.
- Repository content, markdown instructions, files, names, archive paths,
  symlinks, and metadata used during agent execution, setup, diagnostics,
  delivery, and upgrades; some content may be attacker-controlled.
- Scheduled run/continuation payloads, wake receipts, stored queue entries,
  SQLite records, crash/restart recovery inputs, and interleaving requests.
- Environment/configuration values and filesystem paths supplied by an operator,
  distinguishing intentional operator authority from externally controlled data.

## Important security invariants

1. A remote actor who is not authorized for a conversation must not trigger
   coding-agent execution, read session content, view artifacts, or send commands
   by spoofing identities, chats, callbacks, or scheduler events.
2. Conversations and provider sessions must remain isolated across chats,
   topics, projects, users, and workspace boundaries; provider switching,
   fallback, cancellation, and restart must not cross an authorization boundary.
3. Untrusted input must not become an implicit shell command, arbitrary file
   write/read, privileged configuration change, or secret disclosure through
   path traversal, injection, symlink races, logs, diagnostics, or artifacts.
4. Secrets (bot tokens, OAuth tokens, provider credentials and stored connection
   data) must not leak to unauthorized messages, logs, command arguments,
   temporary files, or delivery paths.
5. Stale, superseded, unauthenticated, or replayed runs must not deliver or
   execute work as though they were current and authorized. Verify fencing,
   interruptions, receipts, concurrency, and database migration/recovery.
6. Installer, release, backup, and guarded rollout operations must preserve
   their documented privilege and filesystem safety boundaries, including
   failure/rollback behavior.

## Authorized behavior that is not itself a vulnerability

A coding agent may execute shell commands or edit repository files when an
**authorized user** directs it to do so and the configured provider/tool policy
permits it. Such intended execution is not an Agent Bridge authentication
bypass. Likewise, an operator with local machine control can intentionally
change config and credentials. Focus on crossing boundaries without that
required authority rather than treating the normal power of coding agents as
an exploit.

## Severity and proof guidance

- **Critical:** remotely reachable unauthorized code execution, host takeover,
  or compromise across independent workspace/user boundaries without a
  legitimate authorization prerequisite.
- **High:** unauthorized session takeover, sensitive credential disclosure,
  bypass of message authorization to execute privileged actions, or reliably
  exploitable escalation from lower-trust input to privileged file operations.
- **Medium:** material denial of service, bounded leakage, or bypass requiring
  significant preconditions without credible broad compromise.
- **Low:** defense-in-depth or minor information exposure without a demonstrated
  security impact.

Give an exact reachable source location, trust-boundary explanation, concrete
preconditions, and a minimal reproducible test using fake tokens and fixtures.
Distinguish proof from speculation, note existing mitigations, and propose a
small targeted patch with a regression test. Do not contact production
workspaces, live providers, messaging APIs, or third-party services. All
reproduction should work inside the scanner's offline environment.

## Local build and tests

The Dockerfile installs Node.js 24/npm dependencies and runs `npm run build` and
`npm run typecheck`. Run `npm test` or focused `npx vitest run <test-file>` for
locally reproducible bugs. Some full-system/provider-qualification tests depend
on authenticated providers, messaging credentials, network, or managed hosts;
those are not available inside the offline scanner environment. They should not
be required to validate a local vulnerability.
