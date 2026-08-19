# Target architecture

The accepted target is the provider-native Run model:

```text
conversation / workstream → recoverable turns → native provider session
→ ordinary Run → provider agent + AGENTS.md + Skills + tools
→ provider-native terminal completion → result / external artifacts
```

Health and autonomous work enter through an authenticated durable receipt or
wake and then use the same ordinary Run.

Agent Bridge owns persistence, locks, process supervision, cancellation,
fallback, delivery, and restart reconciliation. The provider owns its native
session, terminal-completion protocol, tools, background work, and subagents. Repository-local instructions and Skills own
engineering workflow.

There is no separate Worker service, job dispatcher, role chain, or Bridge-owned
Task model. Historical Worker tables are compatibility data only.
