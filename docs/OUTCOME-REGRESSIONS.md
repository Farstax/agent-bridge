# Cross-surface outcome regression evidence (#1075)

This inventory records **Bridge-owned observable outcomes** on Telegram, Discord, Slack, and Farstax Desk/outward ACP. It reuses canonical Vitest suites; it is not a model-quality benchmark or evaluation service. The tests use deterministic fake providers unless stated otherwise. **Mocked tool notifications and unit text never prove actual guest privileges**; those require Platform #1508.

| Outcome | Canonical executable evidence and assertion |
| --- | --- |
| Task completes with verifiable output | `test/slackSurfaceIntegration.test.ts`: DM posts the expected `the answer` to native channel and the linked Run is `done`; `test/engineModelFallbackParity.test.ts`: same-provider retry commits one terminal output and publishes a generated artifact exactly once; `test/acpOutwardServer.test.ts`: wire prompt emits one final chunk and one durable completed Run. |
| Context continuity and provider handoff | `test/acpOutwardServer.test.ts`: second ACP process resumes the **same** outward Workstream and inward provider session; **new #1075 test** switches Codex→Claude→Codex over process restart, checks each saved native binding, target-only invalidation, three durable Runs and unchanged Workstream ID; `test/acpSessionMap.test.ts` verifies cross-surface and per-provider isolation. |
| Fallback / capacity is truthful | `test/surfaceNeutralProviderRouter.test.ts`: exhausted/unavailable attempt does not leak an abandoned completion, starts next routeable provider and does not mutate on concurrent status checks; `test/acpOutwardWorkstreams.test.ts` and `test/slackCapacityWaitParity.test.ts`: capacity deferral persists truthful waiting or resumed result without declaring early success; `test/interactiveBot.test.ts` verifies Telegram fallback/explicit preferences. |
| Attachments and tools | `test/acpOutwardQueueDrain.test.ts`: after a capacity retry, staged CSV bytes are parsed inside the fake provider, its deterministic tool result (sum 19) is emitted, and the Run's durable final answer is `csv_sum:19`; `test/acpOutwardBusyMessages.test.ts`: queued text-resource bytes reach the fake provider across ACP processes; `test/acpOutwardAttachments.test.ts` stages text, image and PDF; `test/acpDocumentAttachments.test.ts` handles CSV as readable document; `test/acpOutwardServer.test.ts` checks an ACP tool-call notification crosses the boundary. These are contract checks, **not** proof that a real provider used a native/MCP tool to compute a result; that is an opt-in live qualification requirement. |
| Stop, queue, delivery and restart | `test/acpOutwardBusyMessages.test.ts`: two independently spawned ACP processes, idempotent queue, confirmed remote Stop, cancelled receipts and no duplicate tool execution; `test/acpOutwardQueueDrain.test.ts`: BridgeEngine durable retirement, queued attachments and capacity recovery; OSS #1136 adds held-steering/late-Stop claim fencing; `test/finalDeliveryRecovery.test.ts`: no blind duplicate Telegram/Discord delivery on ambiguous ack. |

| Surface boundary | Canonical suites |
| --- | --- |
| Telegram | `test/telegramUnifiedIngress.test.ts`, `test/interactiveBot.test.ts`, `test/queueModeAcceptance.test.ts`, `test/finalDeliveryRecovery.test.ts` |
| Discord | `test/discord-surrounding-context.test.ts`, `test/discord-surrounding-context-queue.test.ts`, `test/runActivityDiscordDelivery.test.ts`, `test/finalDeliveryRecovery.test.ts` |
| Slack | `test/slackSurfaceIntegration.test.ts`, `test/slackCapacityWaitParity.test.ts`, `test/slackIngress.test.ts` |
| Desk/outward ACP | `test/acpOutwardServer.test.ts`, `test/acpOutwardBusyMessages.test.ts`, `test/acpOutwardQueueDrain.test.ts`, `test/acpOutwardStopConfirmation.test.ts`, `test/acpOutwardWorkstreams.test.ts` |

## Execution

Run the existing focused gate (no credentials or paid calls):

```sh
npm run typecheck
npm test -- test/acpOutwardServer.test.ts test/acpOutwardBusyMessages.test.ts test/acpOutwardQueueDrain.test.ts test/acpOutwardWorkstreams.test.ts test/acpSessionMap.test.ts test/surfaceNeutralProviderRouter.test.ts test/interactiveBot.test.ts test/telegramUnifiedIngress.test.ts test/discord-surrounding-context.test.ts test/runActivityDiscordDelivery.test.ts test/slackSurfaceIntegration.test.ts test/slackCapacityWaitParity.test.ts test/finalDeliveryRecovery.test.ts test/acpOutwardAttachments.test.ts test/acpDocumentAttachments.test.ts
```

Exact-head OSS CI remains the merge gate; record the specific commit SHA, Actions run ID and verdict before closing. The opt-in real-provider boundary is documented by `docs/PROVIDER-QUALIFICATION.md` and `test/autonomousGoalLiveProvider.smoke.test.ts`. Run it **only** in a consented authenticated disposable environment; record the adapter/runtime version, OSS/Platform commits, artifact, actual native/tool result and PASS/DEGRADED/FAIL/NOT RUN. No live credentials or disposable guest tool runner are available from the issue-authoring connection, so no live qualification is claimed. Platform #1508 independently owns actual guest tool privilege, systemd, public HTTPS, SQLite persistence and host-negative isolation evidence.

Repeat bounded live provider checks on material ACP/provider runtime changes or during release qualification, not on routine PRs.
