# Data and event model

Active persistence covers conversations, recoverable turns, native sessions,
Runs, execution locks, event receipts, memories, and audit evidence.

```text
event → authenticated durable receipt → ordinary Run → provider result
```

`work_items`, `work_jobs`, approvals, GitHub links, feature plans, and role
assignment tables may exist in historical databases. Migrations keep them
readable. Active code does not create, claim, or execute those records. No
replacement Task table is allowed.
