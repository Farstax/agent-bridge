from pathlib import Path

source = Path("src/runtimeInspector.ts")
text = source.read_text()
marker = '''function projectRoot(env: Env): string {
  return env.BRIDGE_PROJECT_DIR?.trim() || ROOT;
}

function dbPath(env: Env): string {
'''
replacement = '''function projectRoot(env: Env): string {
  return env.BRIDGE_PROJECT_DIR?.trim() || ROOT;
}

function releaseManifestCommit(root: string): string | null {
  try {
    const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as Row;
    const commit = text(manifest.commit, 120);
    return commit && /^[0-9a-f]{40}$/.test(commit) ? commit : null;
  } catch {
    return null;
  }
}

function dbPath(env: Env): string {
'''
if marker not in text:
    raise SystemExit("projectRoot marker not found")
text = text.replace(marker, replacement, 1)
old = '    const commit=text(env.AGENT_BRIDGE_COMMIT??env.BRIDGE_COMMIT??env.BRIDGE_RELEASE_COMMIT,120);'
new = '    const commit=releaseManifestCommit(projectRoot(env)) ?? text(env.AGENT_BRIDGE_COMMIT??env.BRIDGE_COMMIT??env.BRIDGE_RELEASE_COMMIT,120);'
if old not in text:
    raise SystemExit("commit projection line not found")
source.write_text(text.replace(old, new, 1))

test = Path("test/runtimeInspector.test.ts")
t = test.read_text()
t = t.replace(
    'import { mkdtempSync, rmSync } from "node:fs";',
    'import { mkdtempSync, rmSync, writeFileSync } from "node:fs";',
    1,
)
marker = '  it("supports a capability-only bounded JSON projection", () => {'
addition = r'''  it("projects the exact deployed commit from the active release manifest", () => {
    const { dir, path, db, healthDb } = fixture();
    try {
      const deployed = "c405eb15d742bff21c00f8747d60719b2ed0416b";
      const staleHint = "1111111111111111111111111111111111111111";
      writeFileSync(join(dir, "manifest.json"), JSON.stringify({ schema_version: 1, commit: deployed }));

      const env = {
        AGENT_BRIDGE_CONTEXT_DB: path,
        BRIDGE_PROJECT_DIR: dir,
        AGENT_BRIDGE_COMMIT: staleHint,
        HOME: dir,
      };
      const full = JSON.parse(renderAgentBridgeInspection(["--json"], env));
      const capabilities = JSON.parse(renderAgentBridgeInspection(["capabilities", "--json"], env));
      expect(full.runtime.commit).toBe(deployed);
      expect(capabilities.runtime.commit).toBe(deployed);

      writeFileSync(join(dir, "manifest.json"), JSON.stringify({ schema_version: 1, commit: "not-a-sha" }));
      expect(JSON.parse(renderAgentBridgeInspection(["--json"], env)).runtime.commit).toBe(staleHint);

      expect(JSON.parse(renderAgentBridgeInspection(["--json"], {
        AGENT_BRIDGE_CONTEXT_DB: path,
        BRIDGE_PROJECT_DIR: dir,
        HOME: dir,
      })).runtime.commit).toBeNull();
    } finally {
      db.close();
      healthDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

'''
if marker not in t:
    raise SystemExit("test insertion marker not found")
test.write_text(t.replace(marker, addition + marker, 1))
