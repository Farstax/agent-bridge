from pathlib import Path

path = Path("test/autonomousGoalRuntime.test.ts")
text = path.read_text()
bad = '''function mockSurfaceNeutral(engine: BridgeEngine, implementation: (input: any) => Promise<any>) {
  return mockSurfaceNeutral(engine, async (input: any) =>
    adaptSurfaceResult(input, await implementation(input)));
}
'''
good = '''function mockSurfaceNeutral(engine: BridgeEngine, implementation: (input: any) => Promise<any>) {
  return vi.spyOn(engine, "executeSurfaceNeutralTurn").mockImplementation(async (input: any) =>
    adaptSurfaceResult(input, await implementation(input)));
}
'''
if bad not in text:
    raise SystemExit("recursive mockSurfaceNeutral migration defect not found")
path.write_text(text.replace(bad, good, 1))
