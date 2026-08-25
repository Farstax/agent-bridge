from pathlib import Path
import re


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one match, found {count}")
    return text.replace(old, new, 1)


def remove_call_block(text: str, marker: str, label: str) -> str:
    start = text.find(marker)
    if start < 0:
        raise SystemExit(f"{label}: marker not found")
    brace = text.find("{", start)
    if brace < 0:
        raise SystemExit(f"{label}: opening brace not found")
    depth = 0
    i = brace
    state = "code"
    while i < len(text):
        c = text[i]
        n = text[i + 1] if i + 1 < len(text) else ""
        if state == "code":
            if c == '"': state = "double"
            elif c == "'": state = "single"
            elif c == '`': state = "template"
            elif c == '/' and n == '/': state = "line_comment"; i += 1
            elif c == '/' and n == '*': state = "block_comment"; i += 1
            elif c == '{': depth += 1
            elif c == '}':
                depth -= 1
                if depth == 0:
                    end = text.find(");", i)
                    if end < 0:
                        raise SystemExit(f"{label}: call terminator not found")
                    end += 2
                    if end < len(text) and text[end] == '\n': end += 1
                    return text[:start] + text[end:]
        elif state in ("double", "single", "template"):
            quote = {'double':'"','single':"'",'template':'`'}[state]
            if c == '\\': i += 1
            elif c == quote: state = "code"
        elif state == "line_comment":
            if c == '\n': state = "code"
        elif state == "block_comment":
            if c == '*' and n == '/': state = "code"; i += 1
        i += 1
    raise SystemExit(f"{label}: unterminated block")


engine_path = Path("src/engine.ts")
engine = engine_path.read_text()
engine = replace_once(engine, "  asyncEnabled: boolean;\n", "", "engine option")
engine = replace_once(
    engine,
    """    this.exec = {\n      runCli: exec.runCli ?? _runCli,\n      runCliAsync: exec.runCliAsync ?? _runCliAsync,\n    };\n""",
    """    const runCliAsync = exec.runCliAsync ?? (exec.runCli\n      ? async (command, args, cwd, options) => ({ text: await exec.runCli!(command, args, cwd, options) })\n      : _runCliAsync);\n    this.exec = {\n      runCli: exec.runCli ?? _runCli,\n      runCliAsync,\n    };\n""",
    "execution injection",
)
helper_start = engine.find("function createTypingTracker(")
helper_end = engine.find("// ── BridgeEngine", helper_start)
if helper_start < 0 or helper_end < 0:
    raise SystemExit("typing tracker helper not found")
engine = engine[:helper_start] + engine[helper_end:]
engine = replace_once(engine, '    const mode: "async" | "sync" = this.opts.asyncEnabled === true ? "async" : "sync";\n', "", "turn mode")
engine = replace_once(
    engine,
    "        mode, prompt, sessionId, chatId, chatKey, threadId, attachments, laneHandle, runId, eventContext, collect,\n",
    "        prompt, sessionId, chatId, chatKey, threadId, attachments, laneHandle, runId, eventContext, collect,\n",
    "delivery input",
)
engine = engine.replace('    mode: "async" | "sync";\n', "")
engine = replace_once(
    engine,
    '        showProgressNarration: input.mode === "async" && this.kind === "antigravity" && isAntigravityNarrationVisible(this.db, input.chatKey),\n',
    '        showProgressNarration: this.kind === "antigravity" && isAntigravityNarrationVisible(this.db, input.chatKey),\n',
    "progress narration",
)
engine = replace_once(engine, '        propagateExecutionErrors: input.mode === "sync",\n', '        propagateExecutionErrors: false,\n', "delivery errors")
engine = replace_once(engine, '            ...(input.mode === "sync" ? { skipProviderTyping: true } : {}),\n', "", "sync typing flag")
engine = replace_once(
    engine,
    """          result = input.mode === "async"\n            ? await this.executePromptAsync(input.prompt, input.sessionId, input.chatId, body, onProgress, input.attachments, input.eventContext, input.runId, input.collect, input.chatKey, input.laneHandle)\n            : await this.executePrompt(input.prompt, input.sessionId, input.chatId, body, input.attachments, input.eventContext, input.runId, input.collect, input.chatKey, input.laneHandle);\n""",
    """          result = await this.executePromptAsync(\n            input.prompt, input.sessionId, input.chatId, body, onProgress, input.attachments,\n            input.eventContext, input.runId, input.collect, input.chatKey, input.laneHandle,\n          );\n""",
    "delivery execution",
)
engine = replace_once(engine, """    return this._executeProviderAttempt(\n      "async",\n""", """    return this._executeProviderAttempt(\n""", "async entrypoint")
prompt_start = engine.find("\n  async executePrompt(\n")
provider_start = engine.find("\n  private async _executeProviderAttempt(\n", prompt_start)
if prompt_start < 0 or provider_start < 0:
    raise SystemExit("legacy executePrompt method not found")
engine = engine[:prompt_start] + engine[provider_start:]
engine = engine.replace('    mode: "async" | "sync",\n', "")
engine = replace_once(engine, '      ...(mode === "sync" ? { sessionMode: "resume" as const } : {}),\n', "", "sync session mode")
typing_decl = """    const typingTracker = mode === "sync" && !(body as { skipProviderTyping?: boolean }).skipProviderTyping\n      ? createTypingTracker(this.client, chatId, this.kind, { message_thread_id: threadId }, () => !this._canPublish(laneHandle))\n      : null;\n\n"""
engine = replace_once(engine, typing_decl, "", "typing tracker declaration")
engine = replace_once(engine, "      if (typingTracker) await typingTracker.start();\n\n", "", "typing tracker start")
primary_old = """        if (mode === "async") {\n          (body as { onProviderExecutionStarted?: () => void }).onProviderExecutionStarted?.();\n          stdout = (await this.exec.runCliAsync(invocation.command, invocation.args, cwd, {\n            ...buildExecutionOptions(executionKind),\n            onProgress,\n            onProviderOutputChunk: (body as { onProviderOutputChunk?: (chunk: string) => void }).onProviderOutputChunk,\n            chatId: this._executionLane(chatKey),\n            stdin: invocation.stdin,\n            contextEnv: promptForCli.contextEnv,\n            eventContext,\n            onEvent: collect ?? undefined,\n          })).text;\n        } else {\n          (body as { onProviderExecutionStarted?: () => void }).onProviderExecutionStarted?.();\n          stdout = await this.exec.runCli(invocation.command, invocation.args, cwd, {\n            ...buildExecutionOptions(executionKind),\n            onProviderOutputChunk: (body as { onProviderOutputChunk?: (chunk: string) => void }).onProviderOutputChunk,\n            chatId: this._executionLane(chatKey),\n            stdin: invocation.stdin,\n            contextEnv: promptForCli.contextEnv,\n            eventContext,\n            onEvent: collect ?? undefined,\n          });\n        }\n"""
primary_new = """        (body as { onProviderExecutionStarted?: () => void }).onProviderExecutionStarted?.();\n        stdout = (await this.exec.runCliAsync(invocation.command, invocation.args, cwd, {\n          ...buildExecutionOptions(executionKind),\n          onProgress,\n          onProviderOutputChunk: (body as { onProviderOutputChunk?: (chunk: string) => void }).onProviderOutputChunk,\n          chatId: this._executionLane(chatKey),\n          stdin: invocation.stdin,\n          contextEnv: promptForCli.contextEnv,\n          eventContext,\n          onEvent: collect ?? undefined,\n        })).text;\n"""
engine = replace_once(engine, primary_old, primary_new, "primary provider branch")
invalid_old = """        // Each public adapter injects conversation context itself — do not pre-wrap.\n        if (mode === "async") {\n          return this.executePromptAsync(prompt, null, chatId, body, onProgress, attachments, eventContext, runId, collect, chatKey, laneHandle);\n        }\n        return this.executePrompt(prompt, null, chatId, body, attachments, eventContext, runId, collect, chatKey, laneHandle);\n"""
invalid_new = """        // The canonical provider entrypoint injects conversation context itself — do not pre-wrap.\n        return this.executePromptAsync(prompt, null, chatId, body, onProgress, attachments, eventContext, runId, collect, chatKey, laneHandle);\n"""
engine = replace_once(engine, invalid_old, invalid_new, "invalid-session retry")
engine = engine.replace("attachments, mode, laneHandle,", "attachments, laneHandle,")
engine = engine.replace("attachments, logFile, mode, laneHandle,", "attachments, logFile, laneHandle,")
retry_old = """        rawResult = mode === "async"\n          ? (await this.exec.runCliAsync(retryInvocation.command, retryInvocation.args, retryCwd, {\n              ...buildExecutionOptions(executionKind),\n              onProgress,\n              onProviderOutputChunk: body.onProviderOutputChunk,\n              chatId: this._executionLane(chatKey),\n              stdin: retryInvocation.stdin,\n              eventContext,\n              onEvent: collect ?? undefined,\n            })).text\n          : await this.exec.runCli(retryInvocation.command, retryInvocation.args, retryCwd, {\n              ...buildExecutionOptions(executionKind),\n              onProviderOutputChunk: body.onProviderOutputChunk,\n              chatId: this._executionLane(chatKey),\n              stdin: retryInvocation.stdin,\n              eventContext,\n              onEvent: collect ?? undefined,\n            });\n"""
retry_new = """        rawResult = (await this.exec.runCliAsync(retryInvocation.command, retryInvocation.args, retryCwd, {\n          ...buildExecutionOptions(executionKind),\n          onProgress,\n          onProviderOutputChunk: body.onProviderOutputChunk,\n          chatId: this._executionLane(chatKey),\n          stdin: retryInvocation.stdin,\n          eventContext,\n          onEvent: collect ?? undefined,\n        })).text;\n"""
engine = replace_once(engine, retry_old, retry_new, "antigravity retry branch")
fallback_old = """        rawResult = mode === "async"\n          ? (await this.exec.runCliAsync(fallbackInvocation.command, fallbackInvocation.args, fallbackCwd, {\n              ...buildExecutionOptions(executionKind),\n              onProgress,\n              onProviderOutputChunk: body.onProviderOutputChunk,\n              chatId: this._executionLane(chatKey),\n              stdin: fallbackInvocation.stdin,\n              contextEnv: fallbackPromptForCli.contextEnv,\n              eventContext,\n              onEvent: collect ?? undefined,\n            })).text\n          : await this.exec.runCli(fallbackInvocation.command, fallbackInvocation.args, fallbackCwd, {\n              ...buildExecutionOptions(executionKind),\n              onProviderOutputChunk: body.onProviderOutputChunk,\n              chatId: this._executionLane(chatKey),\n              stdin: fallbackInvocation.stdin,\n              contextEnv: fallbackPromptForCli.contextEnv,\n              eventContext,\n              onEvent: collect ?? undefined,\n            });\n"""
fallback_new = """        rawResult = (await this.exec.runCliAsync(fallbackInvocation.command, fallbackInvocation.args, fallbackCwd, {\n          ...buildExecutionOptions(executionKind),\n          onProgress,\n          onProviderOutputChunk: body.onProviderOutputChunk,\n          chatId: this._executionLane(chatKey),\n          stdin: fallbackInvocation.stdin,\n          contextEnv: fallbackPromptForCli.contextEnv,\n          eventContext,\n          onEvent: collect ?? undefined,\n        })).text;\n"""
engine = replace_once(engine, fallback_old, fallback_new, "fallback provider branch")
engine = replace_once(engine, """    } finally {\n      if (typingTracker) await typingTracker.stop();\n    }\n""", """    }\n""", "typing tracker cleanup")
engine = engine.replace("      asyncEnabled: this.opts.asyncEnabled,\n", "")
engine = engine.replace("// collectors so both sync and async paths expose the resolved session id.", "// collectors so downstream consumers see the resolved session id.")
engine_path.write_text(engine)

# Remove the retired config field from every source and test fixture, including inline objects.
retired_flag = "BRIDGE_ASYNC_" + "ENABLED"
retired_prop = "async" + "Enabled"
for root in [Path("src"), Path("test")]:
    for path in root.rglob("*.ts"):
        text = path.read_text()
        text = re.sub(r'(?m)^[ \t]*const asyncEnabled = process\.env\.[A-Z_]+ !== "false";\s*\n', '', text)
        text = re.sub(r'(?m)^[ \t]*asyncEnabled: boolean;\s*\n', '', text)
        text = re.sub(r'\basyncEnabled:\s*(?:true|false|asyncMode),\s*', '', text)
        text = re.sub(r'(?m)^[ \t]*asyncEnabled,\s*\n', '', text)
        text = re.sub(r'(?m)^.*BRIDGE_ASYNC_ENABLED.*\n', '', text)
        path.write_text(text)

# Delete mode-specific tests rather than carrying dead fixtures forward.
engine_test_path = Path("test/engine.test.ts")
engine_test = engine_test_path.read_text()
engine_test = remove_call_block(
    engine_test,
    '    it("handoff_once suppresses context on a second same-provider turn once a native session exists (sync path)", async () => {',
    "duplicate sync handoff test",
)
engine_test = engine_test.replace(
    '    it("handoff_once suppresses context on a second same-provider turn once a native session exists (async path)", async () => {',
    '    it("handoff_once suppresses context on a second same-provider turn once a native session exists", async () => {',
    1,
)
engine_test = remove_call_block(engine_test, "  // ── Sync path parity with async path", "sync parity suite")
engine_test_path.write_text(engine_test)

Path("test/providerAttemptPipelineOwnership.test.ts").write_text('''import { describe, expect, it, vi } from "vitest";\nimport { mkdtempSync, rmSync } from "node:fs";\nimport { join } from "node:path";\nimport { tmpdir } from "node:os";\nimport { openDb } from "../src/db.js";\nimport { BridgeEngine } from "../src/engine.js";\n\nfunction client() {\n  return {\n    sendMessage: vi.fn().mockResolvedValue({ ok: true, result: { message_id: 1 } }),\n    sendChatAction: vi.fn().mockResolvedValue({ ok: true }),\n    sendPhoto: vi.fn().mockResolvedValue({ ok: true }),\n    sendDocument: vi.fn().mockResolvedValue({ ok: true }),\n  } as any;\n}\n\ndescribe("BridgeEngine provider-attempt contract", () => {\n  it("executes an ordinary provider attempt through the canonical native runtime", async () => {\n    const root = mkdtempSync(join(tmpdir(), "agent-bridge-provider-attempt-"));\n    const db = openDb(join(root, "bridge.sqlite"));\n    const runCli = vi.fn().mockResolvedValue("legacy response");\n    const runCliAsync = vi.fn().mockResolvedValue({ text: "provider response" });\n    const engine = new BridgeEngine({\n      kind: "claude", surfaceIdentity: "test",\n      botConfig: { command: "claude", modelPreference: ["claude-primary"] },\n      allowedUserIds: new Set(["42"]), executionMode: "safe", pollIntervalMs: 1_000,\n    }, db, client(), { runCli, runCliAsync });\n    const handle = db.acquireLock("test", "100");\n    try {\n      expect(handle).not.toBeNull();\n      const result = await engine.executePromptAsync("hello", null, 100, {}, () => {}, [], undefined, null, null, "100", handle!);\n      expect(result.text).toBe("provider response");\n      expect(result.sessionId).toBeNull();\n      expect(runCliAsync).toHaveBeenCalledOnce();\n      expect(runCli).not.toHaveBeenCalled();\n    } finally {\n      if (handle && db.ownsLock(handle)) db.unlock(handle);\n      db.close();\n      rmSync(root, { recursive: true, force: true });\n    }\n  });\n});\n''')

# Remove the environment switch from examples and docs.
for path in [Path(".env.shared.example"), Path(".env.discord-interactive.example")]:
    lines = path.read_text().splitlines(True)
    cleaned = []
    for line in lines:
        if retired_flag in line:
            if cleaned and ("synchronous" in cleaned[-1].lower() or "blocking" in cleaned[-1].lower()):
                cleaned.pop()
            continue
        cleaned.append(line)
    path.write_text(''.join(cleaned))
for path in Path("docs").rglob("*"):
    if not path.is_file(): continue
    try: text = path.read_text()
    except UnicodeDecodeError: continue
    if retired_flag in text:
        path.write_text(''.join(line for line in text.splitlines(True) if retired_flag not in line))

# Extend the existing execution-topology owner with a live single-provider-path invariant.
lint_path = Path("scripts/arch-lint.sh")
lint = lint_path.read_text()
anchor = "check_topology_file \"$TARGET_DIR/providerFallback.ts\" 'buildContextPreamble|contextPreambles'\n"
addition = anchor + "check_topology_file \"$TARGET_DIR/engine.ts\" 'mode: \\\"async\\\" \\| \\\"sync\\\"|async executePrompt\\(' \n"
lint = replace_once(lint, anchor, addition, "architecture ownership guard")
lint_path.write_text(lint)

lint_test_path = Path("test/arch/executionTopologyLint.test.ts")
lint_test = lint_test_path.read_text()
insert = '''\n  it("rejects a second ordinary provider execution mode", () => {\n    const dir = mkdtempSync(join(tmpdir(), "archlint-topology-provider-mode-"));\n    try {\n      writeFileSync(join(dir, "engine.ts"), 'const mode: "async" | "sync" = "async";\\n');\n      const result = runLint(dir);\n      expect(result.code).toBe(1);\n      expect(result.output).toContain("execution topology ownership must remain with the engine");\n    } finally {\n      rmSync(dir, { recursive: true, force: true });\n    }\n  });\n'''
pos = lint_test.rfind("});")
if pos < 0: raise SystemExit("architecture test closing block not found")
lint_test = lint_test[:pos] + insert + lint_test[pos:]
lint_test_path.write_text(lint_test)

# Fail before commit if any retired selector or duplicate ordinary path remains.
problems = []
for root in [Path("src"), Path("test"), Path("docs")]:
    for path in root.rglob("*"):
        if not path.is_file(): continue
        try: text = path.read_text()
        except UnicodeDecodeError: continue
        if retired_flag in text or retired_prop in text:
            problems.append(str(path))
for path in [Path(".env.shared.example"), Path(".env.discord-interactive.example")]:
    if retired_flag in path.read_text(): problems.append(str(path))
engine = engine_path.read_text()
for forbidden in ['mode: "async" | "sync"', 'mode === "async"', 'mode === "sync"', 'async executePrompt(']:
    if forbidden in engine:
        problems.append(f"src/engine.ts still contains {forbidden}")
if problems:
    for problem in problems:
        print(problem)
    raise SystemExit("retired execution topology remains")
