# Data and event model

Active persistence covers conversations, recoverable turns, native sessions,
Runs, execution locks, event receipts, memories, and audit evidence.

```text
event → authenticated durable receipt → ordinary Run → provider result
```

Schema version 9 removes the obsolete `work_items`, `work_jobs`, approvals,
GitHub links, feature plans, and role-assignment tables. The migration drops
populated tables by design. No replacement Task table is allowed.
