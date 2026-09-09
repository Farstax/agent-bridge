#!/usr/bin/env python3
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]

def read(path): return (ROOT/path).read_text()
def write(path, text): (ROOT/path).write_text(text)

def delete_block(text: str, start: str, next_markers=("\n  it(", "\n});", "\ndescribe(")) -> str:
    i = text.find(start)
    if i < 0:
        return text
    candidates = [text.find(m, i + len(start)) for m in next_markers]
    candidates = [x for x in candidates if x >= 0]
    if not candidates:
        raise SystemExit(f"no block end after {start!r}")
    j = min(candidates)
    return text[:i] + text[j+1:]

def delete_it(path, title):
    text = read(path)
    start = f'  it("{title}"'
    out = delete_block(text, start)
    if out == text:
        raise SystemExit(f"missing test {title!r} in {path}")
    write(path, out)

def strip_runtime_env(path):
    lines = read(path).splitlines(True)
    write(path, ''.join(line for line in lines if 'AGENT_BRIDGE_CODEX_RUNTIME' not in line))

# Canonical ACP runtime suite: selector/rollback tests are obsolete, all remaining
# tests exercise the sole Codex runtime directly.
p='test/acpCodexRuntime.test.ts'
t=read(p)
t=t.replace('import { resolveCodexRuntime, isCodexAcpRuntime } from "../src/providers/codexAcpConfig.js";\n','')
start='describe("Codex runtime selection"'
i=t.find(start)
if i < 0: raise SystemExit('missing Codex runtime selection suite')
j=t.find('\ndescribe("Codex ACP provisional answer classification"', i)
if j < 0: raise SystemExit('missing next ACP suite')
t=t[:i]+t[j+1:]
write(p,t)
for title in [
  'keeps the legacy exec invocation when ACP is not selected',
  'does not resume a pre-ACP legacy session after intervening ACP turns',
  'does not resume a pre-legacy ACP session after intervening legacy turns',
]: delete_it(p,title)
strip_runtime_env(p)

# Doctor has one Codex production runtime now.
p='test/providers/doctor.test.ts'
for title in [
  'checks the legacy Codex executable when that runtime is selected',
  'fails closed on an invalid Codex runtime selection',
  'keeps the unconfigured default as legacy Codex',
]: delete_it(p,title)
strip_runtime_env(p)
t=read(p).replace('checks the ACP adapter rather than the legacy executable when ACP is selected','checks the managed ACP adapter for Codex')
t=t.replace('fails when ACP is selected and only the legacy Codex executable exists','fails when only the legacy Codex executable exists')
t=t.replace('respects a custom CODEX_ACP_COMMAND when ACP is selected','respects a custom CODEX_ACP_COMMAND')
write(p,t)

# Registry capability is transport-static now.
p='test/providers.registry.test.ts'
t=read(p)
t=re.sub(r'\s*expect\(supportsToolFreeMode\("codex", \{ AGENT_BRIDGE_CODEX_RUNTIME: "legacy" \}\)\)\.toBe\(true\);\n\s*expect\(supportsToolFreeMode\("codex", \{ AGENT_BRIDGE_CODEX_RUNTIME: "acp" \}\)\)\.toBe\(false\);\n\s*expect\(supportsToolFreeMode\("claude", \{ AGENT_BRIDGE_CODEX_RUNTIME: "acp" \}\)\)\.toBe\(true\);', '\n    expect(supportsToolFreeMode("codex")).toBe(false);\n    expect(supportsToolFreeMode("claude")).toBe(true);', t)
write(p,t)

# Qualification evidence for Codex is ACP-scoped unconditionally.
p='test/providerQualification.test.ts'
strip_runtime_env(p)
t=read(p)
old='''    expect(isQualificationCurrent(current, "codex", "9.9.9")).toBe(true);\n    expect(isQualificationCurrent({ ...current, executionRuntime: "legacy" }, "codex", "9.9.9")).toBe(true);\n    try {\n      expect(isQualificationCurrent(current, "codex", "9.9.9")).toBe(false);\n      expect(isQualificationCurrent({ ...current, executionRuntime: "acp" }, "codex", "9.9.9")).toBe(true);\n    } finally {\n    }'''
new='''    expect(isQualificationCurrent(current, "codex", "9.9.9")).toBe(false);\n    expect(isQualificationCurrent({ ...current, executionRuntime: "legacy" }, "codex", "9.9.9")).toBe(false);\n    expect(isQualificationCurrent({ ...current, executionRuntime: "acp" }, "codex", "9.9.9")).toBe(true);'''
if old not in t: raise SystemExit('provider qualification runtime-current block shape changed')
t=t.replace(old,new)
t=t.replace('versions the Codex ACP executable when ACP runtime is selected','versions the Codex ACP executable used by production')
write(p,t)

# ACP auth no longer has a legacy credential/runtime namespace to cross into.
p='test/acpQualificationBoundaries.test.ts'
for title in [
  'does not reuse ACP credential evidence as legacy Codex verification',
  'fails closed when the supplied qualification runtime differs from the active process runtime',
]: delete_it(p,title)
strip_runtime_env(p)
t=read(p).replace('without invoking legacy codex exec','through the managed ACP adapter')
write(p,t)

# Runtime inspection exposes only ACP session state; rollback projection is gone.
p='test/runtimeInspector.test.ts'
for title in [
  'projects legacy Codex session state from bridge_state',
  'keeps a leftover legacy Codex session as rollback visibility when ACP is selected',
]: delete_it(p,title)
strip_runtime_env(p)
t=read(p).replace('projects ACP Codex bindings instead of the legacy session column','projects Codex ACP session bindings')
t=t.replace('does not claim an ACP-selected Codex provider is available from a Run or the legacy executable','does not claim Codex is available from a Run when the ACP adapter is missing')
write(p,t)

# Remaining suites only needed selector setup to enter the ACP path; ACP is now inherent.
for p in [
 'test/health.test.ts','test/acpProviderCancellation.test.ts','test/interactiveCliAvailability.test.ts',
 'test/executionLaneCorrectness.test.ts','test/advisorBroker.test.ts'
]: strip_runtime_env(p)

# Managed install carries adapter overrides, not a runtime selector.
p='test/codexAcpManagedInstall.test.ts'
t=read(p)
t=t.replace('propagates ACP runtime configuration through the existing interactive service','propagates ACP adapter configuration through the existing interactive service')
t=t.replace('  "AGENT_BRIDGE_CODEX_RUNTIME": "acp",\n','')
t=t.replace('      AGENT_BRIDGE_CODEX_RUNTIME: "acp",\n','')
t=t.replace('allowlists ACP runtime keys on the shared service environment as well','allowlists ACP adapter keys on the shared service environment as well')
t=t.replace('    for (const key of ["AGENT_BRIDGE_CODEX_RUNTIME", "CODEX_ACP_COMMAND", "CODEX_ACP_ARGS"]) {','    for (const key of ["CODEX_ACP_COMMAND", "CODEX_ACP_ARGS"]) {')
t=t.replace('carries ACP runtime keys through source install env seeding and shared defaults','carries ACP adapter keys through source install env seeding and shared defaults')
t=t.replace('    expect(script).toContain("AGENT_BRIDGE_CODEX_RUNTIME");\n','    expect(script).not.toContain("AGENT_BRIDGE_CODEX_RUNTIME");\n')
write(p,t)

# RED test becomes the permanent promotion regression.
p='test/issue737CodexAcpPromotion.red.test.ts'
t=read(p).replace('Codex ACP production promotion','Codex ACP production runtime')
write(p,t)

# Live docs reflect one runtime. Historical ADR/research material remains history.
p='docs/ACP.md'; t=read(p)
t=re.sub(r'The existing `codex exec --json` runtime remains the default\..*?### Managed installation', '''Codex execution is ACP-only. Agent Bridge launches the managed `codex-acp` adapter\nover stdio for ordinary Codex turns. There is no legacy runtime selector or silent\nfallback to `codex exec`.\n\nOptional overrides remain available for adapter diagnostics:\n\n```bash\nCODEX_ACP_COMMAND=/custom/codex-acp\nCODEX_ACP_ARGS="--verbose"\n```\n\n### Managed installation''', t, flags=re.S)
t=t.replace('when they are configured. Rollback to legacy is `AGENT_BRIDGE_CODEX_RUNTIME=legacy`\nwithout changing the rest of the service configuration.\n','when they are configured.\n')
t=t.replace('so the adapter uses the same workspace-local key as `codex exec`. ChatGPT','so the adapter uses the workspace-local key. ChatGPT')
write(p,t)

p='docs/PROVIDER-QUALIFICATION.md'; t=read(p)
t=t.replace('When `AGENT_BRIDGE_CODEX_RUNTIME=acp`, Codex qualification uses the ACP-backed\npath (bundled `codex-acp` over stdio) rather than `codex exec --json`. The','Codex qualification uses the production ACP-backed path (bundled `codex-acp`\nover stdio). The')
write(p,t)

p='docs/runtime-inspection.md'; t=read(p)
t=t.replace('Codex reports the selected execution runtime (`legacy` or `acp`). When ACP is selected, existence comes from `acp_session_bindings` rather than the legacy session column; a leftover legacy session may appear as rollback visibility.','Codex reports runtime `acp`; session existence comes only from `acp_session_bindings`. Legacy Codex session columns are not projected as rollback state.')
write(p,t)

p='docs/provider-api-key-auth.md'; t=read(p)
t=t.replace('| Codex | `CODEX_API_KEY` | bounded `codex exec` turn | `OPENAI_API_KEY` is not the Agent Bridge Codex exec contract |','| Codex | `CODEX_API_KEY` | bounded ACP adapter turn | `OPENAI_API_KEY` is not the Agent Bridge Codex auth contract |')
t=t.replace('- Codex: `CODEX_API_KEY` is the non-interactive `codex exec` API-key environment contract; Codex auth state lives under `CODEX_HOME`.','- Codex: `CODEX_API_KEY` is verified through the managed ACP adapter; Codex auth state lives under `CODEX_HOME`.')
write(p,t)

for p in ['.env.codex.example','.env.discord-interactive.example','.env.interactive.example']:
 t=read(p)
 t=t.replace('# Parallel ACP Codex path. Default remains the legacy `codex exec` runtime.','# Codex runs through the managed ACP adapter.')
 t=t.replace('# Optional headless auth. Agent Bridge uses CODEX_API_KEY for both `codex exec`\n# and the ACP adapter.','# Optional headless auth. Agent Bridge verifies CODEX_API_KEY through the ACP adapter.')
 write(p,t)

# Source comments should not imply a retained legacy runtime.
for p in ['src/providers/apiKeyAuth.ts','src/providers/codexAcpAuthProbe.ts','src/providers/codexAcpRuntime.ts']:
 t=read(p).replace('legacy `codex exec`','removed native Codex runtime').replace('legacy Codex','removed native Codex')
 write(p,t)

print('issue 737 test/docs convergence applied')
