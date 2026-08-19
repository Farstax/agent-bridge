from pathlib import Path
import re

TEST_PATH = Path("test/autonomousGoalRuntime.test.ts")
RUNTIME_PATH = Path("src/autonomousGoalRuntime.ts")

text = TEST_PATH.read_text()
text = text.replace('  parseAutonomousCycleResult,\n', '')
if 'import { execFileSync } from "node:child_process";' not in text:
    text = text.replace(
        'import { describe, expect, it, vi } from "vitest";\n',
        'import { execFileSync } from "node:child_process";\nimport { describe, expect, it, vi } from "vitest";\n',
        1,
    )

helpers = r'''
type TestDisposition = "continue" | "done" | "blocked";

type DispositionCliResult = {
  text: string;
  autonomyDisposition: TestDisposition;
  autonomyNotify?: boolean;
};

function dispositionCommand(prompt: string): string {
  const prefix = "Autonomy disposition command: ";
  const line = prompt.split("\n").find((candidate) => candidate.startsWith(prefix));
  if (!line) throw new Error("missing run-scoped autonomy disposition command");
  return JSON.parse(line.slice(prefix.length)) as string;
}

function invokeDisposition(prompt: string, disposition: TestDisposition, notify = false): void {
  execFileSync(dispositionCommand(prompt), [disposition, ...(notify ? ["--notify"] : [])], { stdio: "pipe" });
}

function cycleOutput(disposition: TestDisposition, evidence: string, notify = false): DispositionCliResult {
  return {
    text: claudeOutput(evidence),
    autonomyDisposition: disposition,
    ...(notify ? { autonomyNotify: true } : {}),
  };
}

function adaptSurfaceResult(input: any, result: any): any {
  if (!result?.autonomyDisposition) return result;
  invokeDisposition(input.prompt, result.autonomyDisposition, result.autonomyNotify === true);
  const envelope = JSON.parse(result.text) as { result?: unknown };
  if (typeof envelope.result !== "string") throw new Error("invalid test provider result envelope");
  return { text: envelope.result } as any;
}

function mockSurfaceNeutral(engine: BridgeEngine, implementation: (input: any) => Promise<any>) {
  return vi.spyOn(engine, "executeSurfaceNeutralTurn").mockImplementation(async (input: any) =>
    adaptSurfaceResult(input, await implementation(input)));
}

'''
if 'type TestDisposition =' not in text:
    marker = '\nfunction makeEngine('
    if marker not in text:
        raise SystemExit('makeEngine insertion marker not found')
    text = text.replace(marker, '\n' + helpers + 'function makeEngine(', 1)

if 'const dispositionAwareRunCliAsync' not in text:
    old = 'function makeEngine(runCliAsync: (...args: any[]) => Promise<{ text: string }>, db: ReturnType<typeof openDb>) {\n  return new BridgeEngine(\n'
    new = '''function makeEngine(runCliAsync: (...args: any[]) => Promise<{ text: string }>, db: ReturnType<typeof openDb>) {
  const dispositionAwareRunCliAsync = async (...args: any[]) => {
    const result = await runCliAsync(...args) as { text: string; autonomyDisposition?: TestDisposition; autonomyNotify?: boolean };
    if (!result.autonomyDisposition) return result;
    const cliArgs = Array.isArray(args[1]) ? args[1] : [];
    const prompt = cliArgs.find((arg: unknown) => typeof arg === "string" && arg.includes("Autonomy disposition command: "));
    if (typeof prompt !== "string") throw new Error("autonomous prompt not found in test CLI invocation");
    invokeDisposition(prompt, result.autonomyDisposition, result.autonomyNotify === true);
    return { text: result.text };
  };
  return new BridgeEngine(
'''
    if old not in text:
        raise SystemExit('makeEngine body marker not found')
    text = text.replace(old, new, 1)
    text = text.replace('    { runCliAsync },\n  );\n}', '    { runCliAsync: dispositionAwareRunCliAsync as any },\n  );\n}', 1)

text = text.replace('vi.spyOn(engine, "executeSurfaceNeutralTurn").mockImplementation(', 'mockSurfaceNeutral(engine, ')
text = text.replace('vi.spyOn(engine, "executeSurfaceNeutralTurn").mockResolvedValue(', 'mockSurfaceNeutral(engine, async () => ')

text = re.sub(r'\{ text: claudeOutput\(\{ status: "progress", evidence: (.*?), nextWakeReason: "[^"]+" \}\) \}', r'cycleOutput("continue", \1)', text)
text = re.sub(r'\{ text: claudeOutput\(\{ status: "complete", evidence: (.*?) \}\) \}', r'cycleOutput("done", \1)', text)
text = re.sub(r'\{ text: claudeOutput\(\{ status: "blocked", evidence: (.*?) \}\) \}', r'cycleOutput("blocked", \1)', text)
text = text.replace(
    '{ text: claudeOutput({ status: inputs.length === 1 ? "progress" : "complete", evidence: `cycle-${inputs.length}`, nextWakeReason: "continue" }) }',
    'cycleOutput(inputs.length === 1 ? "continue" : "done", `cycle-${inputs.length}`)',
)
text = text.replace('    ["complete", "complete"],\n', '    ["done", "complete"],\n')
text = text.replace('    ["cancelled", "cancelled"],\n', '')
text = text.replace('treats a valid %s provider result as terminal', 'treats a valid %s disposition as terminal')
text = text.replace('providerStatus', 'providerDisposition')
text = text.replace('{ text: claudeOutput({ status: providerDisposition, evidence: providerDisposition }) }', 'cycleOutput(providerDisposition, providerDisposition)')
text = text.replace(
    'expect(input.prompt).toContain(index === 0 ? "Wake reason: initial" : "Wake reason: continue");',
    'expect(input.prompt).toContain(index === 0 ? "Wake reason: initial" : "Wake reason: provider requested continuation");',
)
text = text.replace(
    'expect(input.prompt).toContain(\'status must be exactly one of "progress", "complete", "blocked", or "cancelled"\');',
    'expect(input.prompt).toContain("Autonomy disposition command: ");\n      expect(input.prompt).toContain("continue, done, or blocked");\n      expect(input.prompt).not.toContain("Return JSON only");',
)
text = text.replace(
    'expect(events[0]).toMatchObject({ type: "autonomous_cycle_reconciled", goalId: "observed", cycle: 1, goalStatus: "active", cycleStatus: "progress", evidence: "cycle one" });',
    'expect(events[0]).toMatchObject({ type: "autonomous_cycle_reconciled", goalId: "observed", cycle: 1, goalStatus: "active", disposition: "continue", evidence: "cycle one", notify: false });',
)
text = text.replace(
    'expect(events[1]).toMatchObject({ type: "autonomous_cycle_reconciled", goalId: "observed", cycle: 2, goalStatus: "complete", cycleStatus: "complete", evidence: "cycle two done" });',
    'expect(events[1]).toMatchObject({ type: "autonomous_cycle_reconciled", goalId: "observed", cycle: 2, goalStatus: "complete", disposition: "done", evidence: "cycle two done", notify: false });',
)
text = text.replace(
    'expect(Object.keys(events[0]).sort()).toEqual(["cycle", "cycleStatus", "evidence", "goalId", "goalStatus", "runId", "type"]);',
    'expect(Object.keys(events[0]).sort()).toEqual(["cycle", "disposition", "evidence", "goalId", "goalStatus", "notify", "runId", "type"]);',
)
text = text.replace(
    'expect(getAutonomousGoal(db, "cancel-race")).toMatchObject({ status: "cancelled", cycle: 1, evidence: ["late progress"] });',
    'expect(getAutonomousGoal(db, "cancel-race")).toMatchObject({ status: "cancelled", cycle: 1 });\n    expect(getAutonomousGoal(db, "cancel-race").evidence.at(-1)).toContain("operator fence");',
)
text = text.replace(
    'expect(getAutonomousGoal(db, "inflight-cancel")).toMatchObject({ status: "cancelled", evidence: ["late progress"] });',
    'expect(getAutonomousGoal(db, "inflight-cancel").status).toBe("cancelled");\n    expect(getAutonomousGoal(db, "inflight-cancel").evidence.at(-1)).toContain("emergency stop");',
)
text = text.replace('it("fails malformed provider cycle output closed with no successor wake", async () => {', 'it("fails a successful provider response with no disposition closed with no successor wake", async () => {')
text = text.replace('const runCliAsync = vi.fn().mockResolvedValue({ text: claudeOutput("not-json") });', 'const runCliAsync = vi.fn().mockResolvedValue({ text: claudeOutput("ordinary response without a disposition") });')

parser_index = text.find('\ndescribe("parseAutonomousCycleResult", () => {')
if parser_index != -1:
    text = text[:parser_index].rstrip() + '\n'

if 'claudeOutput({ status:' in text:
    raise SystemExit('legacy lifecycle JSON fixture remains')
if 'parseAutonomousCycleResult' in text:
    raise SystemExit('legacy parser test/import remains')
if 'cycleStatus' in text:
    raise SystemExit('legacy cycleStatus expectation remains')
TEST_PATH.write_text(text)

runtime = RUNTIME_PATH.read_text()
runtime = runtime.replace('const MAX_AUTONOMOUS_SUPERVISOR_MESSAGE_CHARS = 3_000;\n', '')
runtime = runtime.replace('export type AutonomousCycleStatus = "progress" | "complete" | "blocked" | "cancelled";\n', '')
parser_start = runtime.find('function parseEnvelope(text: string): string {')
parser_end = runtime.find('function projectEvidence(text: string): string {')
if parser_start != -1:
    if parser_end == -1 or parser_end < parser_start:
        raise SystemExit('legacy parser end marker not found')
    runtime = runtime[:parser_start] + runtime[parser_end:]
result_type_start = runtime.find('export interface AutonomousCycleResult {')
result_type_end = runtime.find('export interface AutonomousSupervisorRoute')
if result_type_start != -1:
    if result_type_end == -1 or result_type_end < result_type_start:
        raise SystemExit('legacy result type end marker not found')
    runtime = runtime[:result_type_start] + runtime[result_type_end:]
if 'parseAutonomousCycleResult' in runtime or 'AutonomousCycleResult' in runtime or 'AutonomousCycleStatus' in runtime:
    raise SystemExit('legacy autonomous lifecycle parser surface remains in runtime')
RUNTIME_PATH.write_text(runtime)
