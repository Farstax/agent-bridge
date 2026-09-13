from pathlib import Path
import subprocess


def run(*args: str, expect_success: bool = True) -> int:
    result = subprocess.run(args, check=False)
    if expect_success and result.returncode != 0:
        raise SystemExit(result.returncode)
    return result.returncode


test = Path("test/engine.test.ts")
text = test.read_text()
start_marker = '    it("suppresses context injection on the prompt following a reset", async () => {'
next_marker = '  });\n\n  describe("group/topic chat run persistence", () => {'
start = text.index(start_marker)
end = text.index(next_marker, start)
replacement = '''    it("re-seeds baseline fresh-session context after reset without restoring deleted history", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();
      db.addConvTurn("100", "user", "prior context");
      db.addConvSummary("100", 1, 1, "Current objective:\\n- prior work");

      let capturedPrompt = "";
      const runCli = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
        capturedPrompt = args[1];
        return cursorResult("done");
      });
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "cursor",
          botConfig: { command: "cursor", modelPreference: ["claude-primary"] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000, workingDir: process.cwd(),
          soulContext: "Identity: Weaver",
          workspaceContext: "Role: Farstax control-plane agent",
        },
        db,
        client,
        { runCli },
      );

      await engine.handleMessages([makeMessage("/reset")]);
      expect(db.getSetting("ctx_suppress:100")).toBeNull();
      await engine.handleMessages([makeMessage("hello after reset")]);
      expect(capturedPrompt).not.toContain("prior context");
      expect(capturedPrompt).not.toContain("Current objective:");
      expect(capturedPrompt).toContain("[Managed workspace context]");
      expect(capturedPrompt).toContain("Role: Farstax control-plane agent");
      expect(capturedPrompt).toContain("Soul contract:");
      expect(capturedPrompt).toContain("Active model: claude-primary");
      expect(capturedPrompt).toContain("Response contract:");
      expect(capturedPrompt).toContain("hello after reset");
    });
'''
test.write_text(text[:start] + replacement + text[end:])

red = run("npx", "vitest", "run", "test/engine.test.ts", "-t", "re-seeds baseline fresh-session context after reset without restoring deleted history", expect_success=False)
if red == 0:
    raise SystemExit("Expected RED test to fail before production repair")
print("Observed expected RED failure")

engine = Path("src/engine.ts")
text = engine.read_text()

old = '''type StagedCliResult = CliResult & {
  nativeSessionMode?: "fresh" | "resume";
};
'''
new = '''type StagedCliResult = CliResult & {
  nativeSessionMode?: "fresh" | "resume";
};

type InvocationContextMode = "fresh" | "resume" | "fresh_without_history";
'''
if text.count(old) != 1:
    raise SystemExit("StagedCliResult insertion target did not match exactly once")
text = text.replace(old, new)

old = '          this.db.setSetting(`ctx_suppress:${chatKey}`, "1");\n'
if text.count(old) != 1:
    raise SystemExit("reset suppression write target did not match exactly once")
text = text.replace(old, "")

old = '''  private _shouldInjectContext(chatKey: string, nativeSessionMode: "fresh" | "resume"): boolean {
    if (this.db.getSetting(`ctx_suppress:${chatKey}`)) return false;
    return nativeSessionMode === "fresh";
  }

  private _buildRecentContextPrompt(chatKey: string, prompt: string, nativeSessionMode: "fresh" | "resume"): string {
    if (!this._shouldInjectContext(chatKey, nativeSessionMode)) return prompt;
    const ctx = this.db.buildConvContext(chatKey, ENGINE_CONTEXT_MAX_CHARS, this.surfaceIdentity);
    return ctx ? `${ctx}${prompt}` : prompt;
  }
'''
new = '''  private _contextMode(chatKey: string, nativeSessionMode: "fresh" | "resume"): InvocationContextMode {
    if (nativeSessionMode === "resume") return "resume";
    const status = this.db.getConvStatus(chatKey, this.surfaceIdentity);
    return status.turnCount > 0 ? "fresh" : "fresh_without_history";
  }

  private _buildRecentContextPrompt(chatKey: string, prompt: string, contextMode: InvocationContextMode): string {
    if (contextMode !== "fresh") return prompt;
    const ctx = this.db.buildConvContext(chatKey, ENGINE_CONTEXT_MAX_CHARS, this.surfaceIdentity);
    return ctx ? `${ctx}${prompt}` : prompt;
  }
'''
if text.count(old) != 1:
    raise SystemExit("context gating target did not match exactly once")
text = text.replace(old, new)

old = '''  private async _buildPromptForCli(chatKey: string, prompt: string, nativeSessionMode: "fresh" | "resume", model: string | null): Promise<{ prompt: string; contextEnv?: Record<string, string>; soulContext: string | null; includeResponseContract: boolean }> {
    const shouldInject = this._shouldInjectContext(chatKey, nativeSessionMode);
    const contextPrompt = this._buildRecentContextPrompt(chatKey, prompt, nativeSessionMode);
    const access = this._buildContextAccess(chatKey);
    const workspacePrompt = this.opts.workspaceContext === undefined
      ? prependWorkspaceContext(contextPrompt, process.env, { includeManagedContext: shouldInject })
      : (shouldInject && this.opts.workspaceContext
          ? `[Managed workspace context]\\n${this.opts.workspaceContext}\\n\\n${contextPrompt}`
          : contextPrompt);
    const fallbackPrompt = nativeSessionMode === "fresh" && isAgentKind(this.kind) && isProviderFallbackHandoffRequired(this.db, chatKey, this.kind)
      ? prependProviderFallbackContinuation(workspacePrompt)
      : workspacePrompt;
    const handoffPrompt = shouldInject ? prependHandoffModel(fallbackPrompt, model) : fallbackPrompt;
    const soulContext = shouldInject ? this.opts.soulContext ?? null : null;
    if (!access) return { prompt: handoffPrompt, soulContext, includeResponseContract: shouldInject };
    return {
      prompt: shouldInject ? `${access.prompt}${handoffPrompt}` : handoffPrompt,
      contextEnv: access.env,
      soulContext,
      includeResponseContract: shouldInject,
    };
  }
'''
new = '''  private async _buildPromptForCli(chatKey: string, prompt: string, nativeSessionMode: "fresh" | "resume", model: string | null): Promise<{ prompt: string; contextEnv?: Record<string, string>; soulContext: string | null; includeResponseContract: boolean }> {
    const contextMode = this._contextMode(chatKey, nativeSessionMode);
    const includeFreshContext = contextMode !== "resume";
    const contextPrompt = this._buildRecentContextPrompt(chatKey, prompt, contextMode);
    const access = this._buildContextAccess(chatKey);
    const workspacePrompt = this.opts.workspaceContext === undefined
      ? prependWorkspaceContext(contextPrompt, process.env, { includeManagedContext: includeFreshContext })
      : (includeFreshContext && this.opts.workspaceContext
          ? `[Managed workspace context]\\n${this.opts.workspaceContext}\\n\\n${contextPrompt}`
          : contextPrompt);
    const fallbackPrompt = nativeSessionMode === "fresh" && isAgentKind(this.kind) && isProviderFallbackHandoffRequired(this.db, chatKey, this.kind)
      ? prependProviderFallbackContinuation(workspacePrompt)
      : workspacePrompt;
    const handoffPrompt = includeFreshContext ? prependHandoffModel(fallbackPrompt, model) : fallbackPrompt;
    const soulContext = includeFreshContext ? this.opts.soulContext ?? null : null;
    if (!access) return { prompt: handoffPrompt, soulContext, includeResponseContract: includeFreshContext };
    return {
      prompt: includeFreshContext ? `${access.prompt}${handoffPrompt}` : handoffPrompt,
      contextEnv: access.env,
      soulContext,
      includeResponseContract: includeFreshContext,
    };
  }
'''
if text.count(old) != 1:
    raise SystemExit("prompt builder target did not match exactly once")
engine.write_text(text.replace(old, new))

text = test.read_text()
start_marker = '    it("handoff flag is only consumed on a turn where context was actually injected", async () => {'
next_marker = '    it("keeps Agent Bridge context env available under handoff_once even when the prompt preamble is suppressed", async () => {'
start = text.index(start_marker)
end = text.index(next_marker, start)
test.write_text(text[:start] + text[end:])

remaining = subprocess.run(["git", "grep", "-n", "ctx_suppress", "--", "src", "test"], check=False)
if remaining.returncode == 0:
    raise SystemExit("ctx_suppress remains in production or tests")

run("npx", "vitest", "run", "test/engine.test.ts")
run("npm", "run", "typecheck")
