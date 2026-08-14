# Issue #388 provider stream contract

This is a research record for issue #388. It records the live CLI contract observed on 2026-08-14. It is not a general provider compatibility guarantee.

## Observed runtime versions

- Codex CLI: `0.147.0`
- Claude Code: `2.1.231`
- Agy CLI: `1.1.13` (not in scope for this issue)

## Probe method

The probes ran from a disposable worktree with bounded non-interactive prompts. Codex used `exec --json`. Claude used `--print --output-format stream-json --verbose --include-partial-messages --tools ''`. Fresh and resumed turns were run for both providers. The captured fixtures contain synthetic answer text and fixture session IDs only.

## Contract findings

Codex fresh and resumed invocations emitted `thread.started`, `turn.started`, one `item.completed` record with an `agent_message`, and `turn.completed`. The answer text arrived only in the completed item. No incremental answer event was observed. Codex remains final-only.

Claude fresh and resumed invocations emitted `stream_event` records. User-visible answer text arrived in `content_block_delta` records where `event.type` is `content_block_delta` and `event.delta.type` is `text_delta`. Thinking deltas, tool records, hook records, system records, assistant snapshots, message lifecycle records, unknown records, and terminal result records shared the stream. Only the text-delta shape is eligible for preview decoding.

Claude text deltas arrived as separate records. A JSONL record can be split across process data chunks, so the decoder owns buffering and parses complete newline-delimited records only. An unterminated or malformed record disables preview output. The final parsed `result` remains authoritative.

## Measurement

One bounded Claude probe produced these local timings from process start:

| Path | First safe answer | Terminal result | First-visible lead |
|---|---:|---:|---:|
| Existing final-only delivery | 6,910 ms | 6,910 ms | 0 ms |
| Structured preview path | 4,401 ms | 6,910 ms | 2,509 ms |

The measurement is a single representative probe. It demonstrates the presentation benefit. It does not claim lower provider compute time.

## Implementation decision

Claude is enabled for safe answer preview using a provider-owned fail-closed decoder. Codex is explicitly retained on final-only delivery because the current structured protocol does not expose a reliable incremental answer event.
