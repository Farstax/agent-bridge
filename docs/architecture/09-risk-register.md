# 09 — Risk Register

> Historical Worker risks are retained for context. Active risks concern
> ordinary Runs, provider sessions, receipts, fencing, and guarded rollout.

| ID | Risk | Likelihood | Impact | Mitigation | Owner phase |
|---|---|---|---|---|---|
| R1 | `isCapacityExhaustedError` over-broad "not found" match misroutes real errors into silent model fallback (cli.ts:843-844) | High (live) | High — masked failures, wrong models | Hotfix now (scope to model-context); permanent fix in adapter classifyError (Epic 2) | Phase 0 |
| R2 | Telegram token reuse across surfaces (appliance TELEGRAM_BOT_TOKEN_WORKER == Agy token) — already broke Agy polling | Occurred | High — bot outage | Dedicated token per surface; startup validation fails fast on duplicates (Epic 1) | Phase 0/1 |
| R3 | Kimchi session scan attaches wrong session when concurrent runs share a cwd (newest-file heuristic, cli.ts resolveKimchiSessionId) | Medium | Medium — context bleed between chats | Pre/post file-set diff or per-cwd serialization; adapter-owned in Epic 2 | Phase 2 |
| R4 | Event/status dual-write divergence during Epic 6 migration | Medium | Medium — wrong status displayed | Same-transaction writes; CI property test reducer==columns; short dual-write window | Phase 3 |
| R5 | Strangler refactor of cli.ts breaks a provider's arg quirks (esp. antigravity log scraping) | Medium | High — provider outage | Characterization tests per provider BEFORE moving code; one provider per PR; canary restart order | Phase 2 |
| R6 | Workflow engine migration alters tdd behaviour subtly | Medium | High — worker produces bad PRs | Golden byte-identical tests; legacy handler kept as fallback flag for one release | Phase 5 |
| R7 | GitHub sync conflict/loops (bridge edits issue → webhook/poll reimports → loop) | Medium | Medium | Marker labels + last-sync etag; bridge-authored changes tagged and skipped on import; deletions never auto-propagated | Phase 6 |
| R8 | SQLite write contention as event volume grows (single writer) | Low | Medium | WAL already implicit via better-sqlite3 usage patterns; monitor via Epic 10; ADR-004 keeps Postgres port possible through repository seam | Continuous |
| R9 | Agent-executed epics repeat past failure mode (tests green, intent missed) | High (proven twice) | Medium | ADR-007: structural acceptance tests + arch-lint in worker gates; ownership diffs required for refactor PRs | All |
| R10 | Appliance divergence: `/opt/agent-bridge` copy drifts from repo, fixes don't propagate | High | Medium | Epic 1 boundary: appliance consumes released OSS artifact; deploy script pins versions; drift check in health bot | Phase 1 |
| R11 | Long-running heavy jobs vs systemd stop timeouts strand jobs mid-step | Low (guards exist) | Medium | Preserve TimeoutStopSec/KillMode settings; workflow step cursor (Epic 5) makes jobs resumable | Phase 5 |
| R12 | Secrets in env files (tokens in /etc/default/*, world-readable risk) | Medium | High | Audit file modes now; move to *_FILE indirection reading ~/.secrets (pattern already used elsewhere on host) | Phase 1 |
