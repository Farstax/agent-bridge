# Agent Bridge architecture

Agent Bridge is a provider-native runtime. It keeps recoverable conversation
turns, provider sessions, ordinary Runs, continuation, fencing, delivery, and
restart recovery. Provider agents own engineering workflow through repository
`AGENTS.md`, Skills, tools, and native subagents.

```text
conversation / workstream
        ↓
recoverable turns and history
        ↓
provider-native session
        ↓
ordinary Run / continuation
        ↓
provider agent + AGENTS.md + Skills + tools
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
dispatcher, role chain, or replacement Task abstraction. Historical Worker
tables remain migration-readable where required by existing databases. Runtime
code does not create, claim, or execute rows in those tables.

The provider adapter owns provider invocation and native protocol details.
`cliSupervisor.ts` remains provider-agnostic. Shared runtime code owns process
supervision, execution locks, Run correlation, cancellation, fallback, and
delivery safety.
