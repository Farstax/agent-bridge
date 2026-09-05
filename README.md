# Agent Bridge

**Keep your coding agents working when you leave your desk.**

Agent Bridge is the open-source, self-hosted runtime for the coding-agent CLIs
you already use. Run Codex, Claude Code, Antigravity/Agy, Grok Build, or Cursor
on an always-on machine and keep the workstream available from Telegram or
Discord.

Built for developers who already use these coding agents and want the same
agents, repositories, tools, and workstreams available away from the laptop.

Keep work running when you close the laptop. Continue from your phone. Switch
providers without throwing away the conversation. Restart the host without
losing the workstream.

Agent Bridge does not replace your coding agents with another agent framework.
It keeps their native CLI and session model, then adds the durable runtime around
them: conversation history, messaging, provider switching and fallback,
cancellation, scheduled work, autonomous continuation, and guarded operations.

## What it feels like to use

1. Give a coding agent a real repository and its normal tools on an always-on host.
2. Work with it through a durable Telegram or Discord conversation.
3. Leave the desk while the same workstream remains available.
4. Check progress, answer questions, stop work, or continue from your phone.
5. Switch provider when useful without creating a new workstream.
6. Let scheduled or autonomous work enter the same ordinary Run path rather than
   a separate workflow engine.

For example:

```text
Telegram topic: Platform
        ↓
Claude Code works in the repository
        ↓
leave the desk
        ↓
reply from your phone
        ↓
switch to Codex when useful
        ↓
same workstream, same repository
```

A Telegram forum topic or Discord conversation can act as a durable workstream:
conversation state belongs to the workstream, while each provider keeps its own
native session underneath it.

## Your agents, not another agent

Agent Bridge is deliberately a runtime around provider-native coding agents.
It does not implement a separate engineering Worker, job dispatcher, role chain,
or Bridge-owned workflow engine.

Say `ship it` in a normal conversation. The selected provider agent follows the
repository's own instructions, `AGENTS.md`, installed Skills, and its native
tools or subagents.

That keeps the execution model simple:

```text
conversation / workstream
        ↓
recoverable turns and history
        ↓
provider-native session
        ↓
ordinary Run / continuation
        ↓
provider agent + AGENTS.md + Skills + tools/native subagents
        ↓
result / external artifacts
```

Unattended work uses an authenticated durable event receipt or autonomous wake,
then enters the same ordinary Run and provider-agent path.

## Core capabilities

- **Durable workstreams** — restart-safe conversation turns and retained history.
- **Native provider sessions** — Codex, Claude Code, Antigravity/Agy, Grok Build,
  and Cursor keep their own session identity rather than being flattened into a
  new harness.
- **Telegram and Discord** — use the coding agents from the messaging surfaces
  you already carry, including Telegram forum-topic routing.
- **Provider switching and fallback** — choose a provider per workstream and use
  configured fallback without replacing the conversation itself.
- **Cancellation and fencing** — `/stop` prevents superseded work from continuing
  to deliver as if it were current.
- **Conversation controls** — `/reset`, `/cli`, `/btw`, queueing, continuation,
  and restart recovery use the ordinary interactive runtime.
- **Scheduled and autonomous work** — routines and authenticated wakes feed the
  same Run path as interactive work.
- **Structured results and file delivery** — provider results and artifacts can
  be delivered back through the active surface.
- **Skills and repository-local instructions** — keep behaviour close to the
  repository and provider instead of centralising it in Bridge workflows.
- **Guarded operations** — health, qualification, schema, install, and release
  helpers support long-running deployments.

## Quick start from source

Requirements:

- Node.js 24+
- npm
- at least one authenticated provider CLI
- a Telegram or Discord bot token for the surface you want to use

Clone the repository and install dependencies:

```bash
git clone https://github.com/Farstax/agent-bridge.git
cd agent-bridge
npm install
```

For a switchable Telegram setup, run the source setup wizard:

```bash
npm run setup
```

It detects supported provider CLIs, asks for the Telegram bot token, allowed user
IDs, and repository/project directory, writes `.env.interactive` with mode
`0600`, and runs the existing Doctor checks. The generated secret file is ignored
by Git and the wizard refuses to replace it unless you deliberately pass
`--force`.

Then start the interactive runtime:

```bash
npm start
```

For manual configuration, copy [`.env.interactive.example`](.env.interactive.example).
The switchable interactive runtime uses `INTERACTIVE_CLI_CHAIN` for provider
fallback. Provider-locked and production deployment details live in the operator
documentation below.

See [source/self-hosting examples](docs/examples/README.md) for multi-provider
Telegram, Telegram topic workstreams, Discord interactive, and scheduled
routines.

## Production installation

The source quick start is for development and source-oriented hosts. Production
installation uses an exact qualified release archive, a non-root runtime user,
managed systemd units, persistent databases outside the release tree, and the
guarded deploy path.

See:

- [Initial production installation](docs/INITIAL-INSTALL.md)
- [Guarded rollout](docs/GUARDED-ROLLOUT.md)
- [Architecture overview](docs/architecture/overview.md)
- [Documentation map](docs/README.md)

The production installer establishes the baseline once. Existing installations
move between exact releases with `agent-bridge-deploy` rather than rerunning the
initial installer.

## Runtime and Platform boundary

Agent Bridge is the open-source runtime. It assumes you provide the machine,
provider credentials, messaging surface, repository, and operating environment.

[Farstax](https://farstax.com/) is the separate hosted/control-plane product that
provides managed always-on workspaces and operations around Agent Bridge. The
runtime/platform responsibility boundary is documented in
[docs/architecture/platform-boundary.md](docs/architecture/platform-boundary.md).

## Open-source licence

Agent Bridge material in this repository is licensed under the
[Apache License 2.0](LICENSE), except for third-party material that carries its
own licence. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for bundled
third-party attribution.

The licence applies to this public `agent-bridge` repository only. It does not
license `agent-bridge-platform`, the Farstax hosted control plane, managed
hosting or provisioning services, commercial operations, or other proprietary
Platform assets.

The licence decision and rationale are recorded in
[ADR-004](docs/adr/ADR-004-oss-license.md).

## Development

```bash
npm test
npm run typecheck
npm run cleanup:check
```

Research and archive documents provide historical context; the current runtime
behaviour is defined by the code, tests, active architecture docs, and release
qualification paths.