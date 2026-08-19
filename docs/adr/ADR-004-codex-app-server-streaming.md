# ADR 004: Codex App Server Streaming Spike Evaluation

* **Status:** Rejected (streaming not adopted; Codex remains final-only)
* **Date:** 2026-08-19
* **Authors:** Antigravity AI & Nick Constantinou
* **Context Issue:** [Issue #413](https://github.com/nickconstantinou/agent-bridge/issues/413)

---

## Context

We evaluated the feasibility of adopting the official **Codex App Server** integration surface (`codex app-server`) for safe, early answer streaming in Agent Bridge, as an alternative to the current final-only `codex exec --json` execution path.

### Supported Version & Reference Details
- **CLI Version:** `codex-cli 0.148.0`
- **Official References:**
  - [Codex App Server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
  - [Unlocking the Codex Harness Blog Post](https://openai.com/index/unlocking-the-codex-harness/)

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
    "userAgent": "bridge-probe/0.148.0 (Ubuntu 24.4.0; x86_64) gnome-terminal (bridge-probe; 1.0.0)",
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
* **Setup:** Turn involving reasoning steps and command execution before yielding the final answer.
* **Trace Sequence:**
```json
<<< {"method":"item/started","params":{"item":{"type":"reasoning","id":"item-reason-1","summary":["Executing bash command"]},"threadId":"...","turnId":"..."}}
<<< {"method":"item/reasoning/textDelta","params":{"itemId":"item-reason-1","delta":"Thinking..."}}
<<< {"method":"item/completed","params":{"item":{"type":"reasoning","id":"item-reason-1"},"threadId":"...","turnId":"..."}}
<<< {"method":"item/started","params":{"item":{"type":"toolCall","id":"item-tool-1","tool":{"type":"bash","command":"ls"}},"threadId":"...","turnId":"..."}}
<<< {"method":"item/commandExecution/outputDelta","params":{"itemId":"item-tool-1","delta":"package.json\n"}}
<<< {"method":"item/completed","params":{"item":{"type":"toolCall","id":"item-tool-1"},"threadId":"...","turnId":"..."}}
<<< {"method":"item/started","params":{"item":{"type":"agentMessage","id":"item-agent-2","phase":"final_answer","text":""},"threadId":"...","turnId":"..."}}
<<< {"method":"item/agentMessage/delta","params":{"itemId":"item-agent-2","delta":"The files exist."}}
<<< {"method":"item/completed","params":{"item":{"type":"agentMessage","id":"item-agent-2","phase":"final_answer","text":"The files exist."}}
<<< {"method":"turn/completed","params":{"threadId":"...","turn":{"id":"...","status":"completed"}}}
```
Reasoning text (`item/reasoning/textDelta`) and tool call outputs are cleanly isolated from the final answer text (`item/agentMessage/delta`), avoiding exposure of raw protocol steps.

### 4. Commentary vs Final-Answer Behavior
When `MessagePhase` is `null`/unknown on `codex-cli 0.148.0`, the server omits the `"phase"` key in the `item/started` payload:
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
>>> {"jsonrpc": "2.0", "id": 4, "method": "turn/interrupt", "params": {"threadId":"thread-fresh-id"}}
<<< {"id":4,"result":{}}
<<< {"method":"turn/completed","params":{"threadId":"thread-fresh-id","turn":{"id":"turn-fresh-id","status":"interrupted"}}}
```
Interrupted turns terminate explicitly with status `"interrupted"`, not `"failed"`.

### 6. Failure/Capacity/Error Path
* **Setup:** Server hits usage limits or connection failure.
* **Trace Sequence:**
```json
<<< {"method":"error","params":{"error":{"message":"You've hit your usage limit. Upgrade to Pro...","codexErrorInfo":"usageLimitExceeded"}}}
<<< {"method":"turn/completed","params":{"threadId":"...","turn":{"id":"...","status":"failed","error":{"message":"You've hit your usage limit. Upgrade to Pro..."}}}}
```
Errors are explicitly typed via the `"error"` notification and mapped to `"failed"` status at turn completion.

### 7. Long Answer
* **Setup:** Response requiring reconstructed stream.
* **Trace Sequence:**
Consecutive `item/agentMessage/delta` objects carry sequential text chunks mapped to the same `itemId`. Concatenation yields the authoritative final result prior to receiving `item/completed`.

---

## Latency Opportunity Measurement

Based on simulated success paths for short turns:
- **Turn Start:** `t = 0.0s`
- **First eligible delta (`item/agentMessage/delta`):** `t = 1.2s`
- **Turn Completion (`turn/completed`):** `t = 3.5s`
- **Latency Win:** Streaming saves **2.3 seconds** (~65% reduction in initial presentation latency) over waiting for the final completion envelope.

---

## Minimal Lifecycle Model

If the App Server were adopted, the recommended lifecycle model is:
- **One process per execution run:** Start a single `codex app-server --stdio` child process for each run invocation, utilizing standard JSON-RPC over stdio.
- **Bypass daemons:** Rather than maintaining a persistent background daemon across different user turns, the child process is spawned, handled, and killed within the boundaries of a single run turn. This ensures clean session isolation, simplifies SIGTERM/SIGINT process cleanup, and avoids introducing background state daemons.

---

## Decision

### 🔴 Decision: **B — App Server is not suitable yet**

We confirm that **Option B is the correct and defensible final decision**.

The key blocker is that `MessagePhase` is not consistently emitted by the provider, resulting in frequent `null` or absent phase values in realistic answer streams. To satisfy the safety gates and prevent leaking agent commentary (such as internal narration or wait status updates) without using fragile text heuristics, we must keep Codex execution **final-only** using the existing `exec --json` path.
