# ADR 004: Codex App Server Streaming Spike Evaluation

* **Status:** Rejected (streaming not adopted; Codex remains final-only)
* **Date:** 2026-08-22
* **Authors:** Antigravity AI & Nick Constantinou
* **Context Issue:** [Issue #413](https://github.com/nickconstantinou/agent-bridge/issues/413)

---

## Context

We evaluated the feasibility of adopting the official **Codex App Server** integration surface (`codex app-server`) for safe, early answer streaming in Agent Bridge, as an alternative to the current final-only `codex exec --json` execution path.

### Supported Version & Reference Details
- **CLI Version:** `codex-cli 0.149.0` (installed on the Agent Bridge host)
- **Official References:**
  - [Codex App Server documentation](https://learn.chatgpt.com/docs/app-server)
  - [Codex App Server source](https://github.com/openai/codex/tree/main/codex-rs/app-server)

---

## Handshake and Version Verification

### Stdio Handshake Sequence
The connection initiates via standard JSON-RPC over `stdio` (`--stdio`). The client sends the `initialize` method:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "clientInfo": {
      "name": "bridge-probe",
      "title": "Agent Bridge Probe",
      "version": "1.0.0"
    },
    "capabilities": {
      "experimentalApi": true,
      "requestAttestation": false
    }
  }
}
```
The server responds with client environment details:
```json
{
  "id": 1,
  "result": {
    "userAgent": "agent_bridge_spike_probe/0.149.0 (Ubuntu 24.4.0; x86_64) dumb (agent_bridge_spike_probe; 0.1.0)",
    "codexHome": "/home/content-crawler/.codex",
    "platformFamily": "unix",
    "platformOs": "linux"
  }
}
```

---

## Sanitized Protocol Traces

### 1. Fresh Short Answer
* **Setup:** Client initializes a new thread and turn.
* **Trace Sequence:**
```json
// Start Thread
>>> {"jsonrpc": "2.0", "id": 2, "method": "thread/start", "params": {}}
<<< {"id":2,"result":{"thread":{"id":"thread-fresh-id","status":{"type":"idle"},"turns":[]}}}

// Start Turn
>>> {"jsonrpc": "2.0", "id": 3, "method": "turn/start", "params":{"threadId":"thread-fresh-id","input":[{"type":"text","text":"say hello"}]}}
<<< {"method":"thread/started","params":{"thread":{"id":"thread-fresh-id","status":{"type":"idle"},"turns":[]}}}
<<< {"id":3,"result":{"turn":{"id":"turn-fresh-id","status":"inProgress","items":[]}}}
<<< {"method":"thread/status/changed","params":{"threadId":"thread-fresh-id","status":{"type":"active","activeFlags":[]}}}
<<< {"method":"turn/started","params":{"threadId":"thread-fresh-id","turn":{"id":"turn-fresh-id","status":"inProgress"}}}
<<< {"method":"item/started","params":{"item":{"type":"userMessage","id":"item-user-1","content":[{"type":"text","text":"say hello"}]},"threadId":"thread-fresh-id","turnId":"turn-fresh-id"}}
<<< {"method":"item/completed","params":{"item":{"type":"userMessage","id":"item-user-1","content":[{"type":"text","text":"say hello"}]},"threadId":"thread-fresh-id","turnId":"turn-fresh-id"}}
<<< {"method":"item/started","params":{"item":{"type":"agentMessage","id":"item-agent-1","phase":"final_answer","text":""},"threadId":"thread-fresh-id","turnId":"turn-fresh-id"}}
<<< {"method":"item/agentMessage/delta","params":{"itemId":"item-agent-1","delta":"Hello","threadId":"thread-fresh-id","turnId":"turn-fresh-id"}}
<<< {"method":"item/agentMessage/delta","params":{"itemId":"item-agent-1","delta":"!","threadId":"thread-fresh-id","turnId":"turn-fresh-id"}}
<<< {"method":"item/completed","params":{"item":{"type":"agentMessage","id":"item-agent-1","phase":"final_answer","text":"Hello!"},"threadId":"thread-fresh-id","turnId":"turn-fresh-id"}}
<<< {"method":"turn/completed","params":{"threadId":"thread-fresh-id","turn":{"id":"turn-fresh-id","status":"completed","items":[{"type":"userMessage","id":"item-user-1"},{"type":"agentMessage","id":"item-agent-1"}]}}}
```

### 2. Resumed Thread
* **Setup:** Client resumes an existing thread using its `threadId`.
* **Trace Sequence:**
```json
>>> {"jsonrpc": "2.0", "id": 2, "method": "thread/resume", "params": {"threadId": "thread-fresh-id"}}
<<< {"id":2,"result":{"thread":{"id":"thread-fresh-id","status":{"type":"idle"},"turns":[{"id":"turn-fresh-id","status":"completed","items":[...]}]}}}
```
The event shape matches the fresh thread start but retains state, avoiding the need for the bridge to replay context.

### 3. Tool Use Followed by Answer
* **Setup:** A turn was instructed to run `pwd` before answering.
* **Trace Sequence:**
```json
<<< {"method":"item/started","params":{"item":{"type":"reasoning","id":"item-reason-1","summary":["Executing bash command"]},"threadId":"...","turnId":"..."}}
<<< {"method":"item/completed","params":{"item":{"type":"reasoning","id":"item-reason-1"},"threadId":"...","turnId":"..."}}
<<< {"method":"item/started","params":{"item":{"type":"agentMessage","id":"item-agent-2","phase":"final_answer","text":""},"threadId":"...","turnId":"..."}}
<<< {"method":"item/agentMessage/delta","params":{"itemId":"item-agent-2","delta":"The files exist."}}
<<< {"method":"item/completed","params":{"item":{"type":"agentMessage","id":"item-agent-2","phase":"final_answer","text":"The files exist."}}
<<< {"method":"turn/completed","params":{"threadId":"...","turn":{"id":"...","status":"completed"}}}
```
The live run emitted reasoning items followed by a final-answer item. It did not emit a command item on this host because App Server reported that the Linux bubblewrap sandbox could not create user namespaces. The probe therefore does not claim successful command-event coverage. The protocol has separate item types for reasoning and command execution, but the command path needs a host with a functioning Codex sandbox for a real trace.

### 4. Commentary vs Final-Answer Behavior
The generated 0.149.0 protocol schema defines `MessagePhase` as `commentary` or `final_answer`, but its contract description says that providers do not emit it consistently and that callers must treat a missing value as unknown. The schema therefore does not provide a universal safety guarantee.

The real 0.149.0 fresh, resumed, and short tool-directed probes emitted `phase: "final_answer"` for the observed answer items. That proves the safe path exists. It does not prove that every supported turn will carry the discriminator. The unsafe case remains:
```json
<<< {"method":"item/started","params":{"item":{"type":"agentMessage","id":"item-agent-commentary","text":""}}}
<<< {"method":"item/agentMessage/delta","params":{"itemId":"item-agent-commentary","delta":"No tool calls are needed now. I will wait..."}}
```
Without the phase field, the client cannot distinguish whether this delta is raw commentary/narration or the user-visible final answer. 
* Streaming all deltas when phase is `null`/unknown leaks internal agent commentary.
* Blocking all deltas with unknown phase renders streaming non-functional for those turns.
* Since text heuristics are prohibited, streaming is classified as unsafe.

### 5. Cancellation
* **Setup:** Client interrupts an active turn.
* **Trace Sequence:**
```json
>>> {"jsonrpc": "2.0", "id": 4, "method": "turn/interrupt", "params": {"threadId":"thread-fresh-id", "turnId":"turn-fresh-id"}}
<<< {"id":4,"result":{}}
<<< {"method":"turn/completed","params":{"threadId":"thread-fresh-id","turn":{"id":"turn-fresh-id","status":"interrupted"}}}
```
Interrupted turns terminate explicitly with status `"interrupted"`, not `"failed"`.

### 6. Failure/Capacity/Error Path
* **Setup:** No deterministic capacity failure was induced during the bounded probe.
* **Trace Sequence:**
```json
<<< {"method":"turn/completed","params":{"threadId":"...","turn":{"id":"...","status":"failed","error":{"message":"<provider error>"}}}}
```
The documented protocol provides typed error fields on failed terminal turns. This spike did not claim a live capacity/error trace because inducing one would require an external failure or quota change.

### 7. Long Answer
* **Setup:** Response requiring reconstructed stream.
* **Trace Sequence:**
Consecutive `item/agentMessage/delta` objects carry sequential text chunks mapped to the same `itemId`. Concatenation yields the authoritative final result prior to receiving `item/completed`.

---

## Latency Opportunity Measurement

One real 0.149.0 short-turn probe measured:
- **First eligible delta (`item/agentMessage/delta`):** `2.312s` after `turn/started`.
- **Turn completion (`turn/completed`):** `2.443s` after `turn/started`.

This is presentation-latency evidence for one run, not a provider benchmark. The delta arrived before the authoritative completion event.

---

## Minimal Lifecycle Model

If the App Server were adopted, the recommended lifecycle model is:
- **One process per execution run:** Start a single `codex app-server --stdio` child process for each run invocation, utilizing standard JSON-RPC over stdio.
- **Bypass daemons:** Rather than maintaining a persistent background daemon across different user turns, the child process is spawned, handled, and killed within the boundaries of a single run turn. This ensures clean session isolation, simplifies SIGTERM/SIGINT process cleanup, and avoids introducing background state daemons.

---

## Decision

### 🔴 Decision: **B — App Server is not suitable yet**

We confirm that **Option B is the correct and defensible final decision**.

The current CLI provides the required native lifecycle primitives and emitted safe final-answer deltas in the probes. The safety gate still fails because the generated 0.149.0 schema explicitly permits a missing or unknown `MessagePhase`, and the protocol does not provide a stable guarantee that every `agentMessage` delta is final-answer text. The command-directed probe also emitted a host sandbox warning and no command item, so command-event coverage was not claimed as a successful live observation.

Agent Bridge must keep Codex execution **final-only** using the existing `exec --json` path. A future streaming implementation requires a provider contract that makes the final-answer discriminator mandatory and stable, or an equivalent explicit safe-content contract. Heuristics are out of scope.
