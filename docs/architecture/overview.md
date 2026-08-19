# Agent Bridge architecture

Agent Bridge is a provider-native runtime. It keeps recoverable conversation
turns, provider sessions, ordinary Runs, fencing, delivery, and restart
reconciliation. Provider-owned background work stays inside the native CLI turn. Provider agents own engineering workflow through repository
`AGENTS.md`, Skills, tools, and native subagents.

```text
conversation / workstream
        ↓
recoverable turns and history
        ↓
provider-native session
        ↓
ordinary Run
        ↓
provider agent + AGENTS.md + Skills + tools
        ↓
provider-native terminal completion
        ↓
result and external artifacts
```

Unattended work uses the same path:

```text
authenticated durable event receipt
        ↓
ordinary owning Run
        ↓
provider agent + Skills
        ↓
result
```

Agent Bridge has no separate engineering workflow engine, Worker bot, job
dispatcher, role chain, or replacement Task abstraction. Schema version 9
removes the historical Worker tables. Runtime code does not create, claim, or
execute rows in those tables.

The provider adapter owns provider invocation and native terminal-completion protocol details.
`cliSupervisor.ts` remains provider-agnostic. Shared runtime code owns process
supervision, execution locks, Run correlation, cancellation, fallback, and
delivery safety.
