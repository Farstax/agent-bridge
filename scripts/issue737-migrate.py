#!/usr/bin/env python3
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]

def read(path): return (ROOT / path).read_text()
def write(path, text): (ROOT / path).write_text(text)
def replace(path, old, new, count=None):
    text = read(path)
    found = text.count(old)
    if found == 0:
        raise SystemExit(f"missing expected text in {path}: {old[:100]!r}")
    if count is not None and found != count:
        raise SystemExit(f"unexpected count in {path}: {found} != {count} for {old[:100]!r}")
    write(path, text.replace(old, new))

def sub(path, pattern, repl, count=0):
    text = read(path)
    out, n = re.subn(pattern, repl, text, count=count, flags=re.S)
    if n == 0:
        raise SystemExit(f"missing regex in {path}: {pattern[:120]!r}")
    write(path, out)

# Collapse the temporary selector into ACP-only launch configuration.
selector = ROOT / "src/providers/codexRuntimeSelection.ts"
config = ROOT / "src/providers/codexAcpConfig.ts"
selector.rename(config)
config.write_text('''import { dirname, join } from "node:path";\nimport { fileURLToPath } from "node:url";\n\nexport function resolveBridgeProjectDir(\n  env: Record<string, string | undefined> = process.env,\n): string {\n  const configured = env.BRIDGE_PROJECT_DIR?.trim();\n  if (configured) return configured;\n  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");\n}\n\nexport function bundledCodexAcpCommand(\n  env: Record<string, string | undefined> = process.env,\n): string {\n  return join(resolveBridgeProjectDir(env), "node_modules", ".bin", "codex-acp");\n}\n\nexport function resolveCodexAcpCommand(\n  env: Record<string, string | undefined> = process.env,\n): string {\n  return env.CODEX_ACP_COMMAND?.trim() || bundledCodexAcpCommand(env);\n}\n\nexport function resolveCodexAcpArgs(\n  env: Record<string, string | undefined> = process.env,\n): string[] {\n  const raw = env.CODEX_ACP_ARGS?.trim();\n  if (!raw) return [];\n  return raw.split(/\\s+/).filter(Boolean);\n}\n''')
for path in ROOT.rglob('*'):
    if path.is_file() and path.suffix in {'.ts','.md','.sh','.py'}:
        text = path.read_text(errors='ignore')
        if 'codexRuntimeSelection' in text:
            path.write_text(text.replace('codexRuntimeSelection', 'codexAcpConfig'))

# Codex execution is ACP-only.
replace('src/cli.ts', 'import * as codexRuntime from "./providers/codexRuntime.js";\n', '')
replace('src/cli.ts', 'import { isCodexAcpRuntime } from "./providers/codexAcpConfig.js";\n', '')
sub('src/cli.ts', r'  if \(bot === "codex"\) \{\n    const request = \{\n      prompt: providerPrompt, sessionId, command, model, executionMode, outputFormat, soulContext, includeResponseContract, attachments, outputDir, effort, toolMode, nativeCompletion,\n    \};\n    return isCodexAcpRuntime\(bot\)\n      \? codexAcpRuntime\.buildInvocation\(request\)\n      : codexRuntime\.buildInvocation\(request\);\n  \}', '  if (bot === "codex") {\n    return codexAcpRuntime.buildInvocation({\n      prompt: providerPrompt, sessionId, command, model, executionMode, outputFormat, soulContext, includeResponseContract, attachments, outputDir, effort, toolMode, nativeCompletion,\n    });\n  }')
replace('src/cli.ts', 'export { isCodexAcpRuntime, resolveCodexRuntime } from "./providers/codexAcpConfig.js";\n', '')
sub('src/cli.ts', r'  if \(bot === "codex"\) \{\n    result = codexRuntime\.parseResult\(stdout\);\n  \} else if \(bot === "claude"\)', '  if (bot === "codex") {\n    throw new Error("Codex uses ACP structured results and is not parsed as native CLI output");\n  } else if (bot === "claude")')

# Engine session continuity is ACP-only for Codex; remove rollback cross-clearing.
replace('src/engine.ts', 'import { resolveCodexRuntime } from "./providers/codexAcpConfig.js";\n', '')
replace('src/engine.ts', 'if (kind === "codex" && resolveCodexRuntime() === "acp") {', 'if (kind === "codex") {', count=2)
replace('src/engine.ts', '      // A completed ACP turn makes any stored legacy Codex session stale: it\n      // predates this ACP history and must not be resumed as legacy later.\n      db.setSession(chatKey, "codex", null);\n', '')
replace('src/engine.ts', '    // Symmetric to the ACP branch above: a completed legacy Codex turn makes\n    // any stored ACP session binding stale, so a later switch back to ACP\n    // must not resume it as though it saw this turn.\n    if (kind === "codex" && sessionId) db.clearAcpSessionBinding(chatKey, "codex");\n', '')

# ACP cannot satisfy strict tool-free, regardless of env.
replace('src/providers/registry.ts', 'import { isCodexAcpRuntime } from "./codexAcpConfig.js";\n', '')
sub('src/providers/registry.ts', r'export function supportsToolFreeMode\(\n  bot: string,\n  env: Record<string, string \| undefined> = process\.env,\n\): boolean \{\n  const id = BOT_NAME_TO_PROVIDER_ID\[bot\];\n  if \(!id\) return false;\n  try \{\n    if \(id === "codex" && isCodexAcpRuntime\("codex", env\)\) return false;\n  \} catch \{\n    return false;\n  \}\n  return ADAPTERS\[id\]\.capabilities\.toolFree;\n\}', 'export function supportsToolFreeMode(bot: string): boolean {\n  const id = BOT_NAME_TO_PROVIDER_ID[bot];\n  if (!id || id === "codex") return false;\n  return ADAPTERS[id].capabilities.toolFree;\n}')

# API-key verification is always scoped to the selected ACP adapter for Codex.
replace('src/providers/apiKeyAuth.ts', 'import { resolveCodexRuntime } from "./codexAcpConfig.js";\n', '')
replace('src/providers/apiKeyAuth.ts', '    notes: "Legacy Codex verifies with codex exec; Codex ACP verifies through the selected adapter\'s ACP authenticate + bounded prompt path.",', '    notes: "Codex verifies through the managed ACP adapter\'s authenticate + bounded prompt path.",')
sub('src/providers/apiKeyAuth.ts', r'function codexAcpOwnsApiKeyValidation\(provider: ProviderId, env: Env\): boolean \{.*?\n\}', 'function codexAcpOwnsApiKeyValidation(provider: ProviderId, _env: Env): boolean {\n  return provider === "codex";\n}', count=1)
sub('src/providers/apiKeyAuth.ts', r'function verificationScope\(provider: ProviderId, env: Env\): string \{.*?\n\}', 'function verificationScope(provider: ProviderId, _env: Env): string {\n  return provider === "codex" ? "acp" : "native";\n}', count=1)

# Doctor, setup and interactive availability all inspect the same managed ACP binary.
replace('src/providers/doctor.ts', 'import { resolveCodexAcpCommand, resolveCodexRuntime } from "./codexAcpConfig.js";', 'import { resolveCodexAcpCommand } from "./codexAcpConfig.js";')
sub('src/providers/doctor.ts', r'function inspectCodexProvider\(.*?\n\}\n\nexport function runDoctor', '''function inspectCodexProvider(\n  env: Record<string, string | undefined>,\n  commandExists: (executable: string) => boolean,\n  inspectVersion: (executable: string) => string | null,\n): ProviderCheck {\n  const executable = resolveCodexAcpCommand(env);\n  const available = commandExists(executable);\n  return {\n    id: "codex",\n    executable,\n    status: available ? "available" : "missing",\n    runtime: "acp",\n    ...(available ? { version: inspectVersion(executable) } : {}),\n  };\n}\n\nexport function runDoctor''', count=1)
replace('src/setup.ts', 'import { resolveCodexAcpCommand, resolveCodexRuntime } from "./providers/codexAcpConfig.js";', 'import { resolveCodexAcpCommand } from "./providers/codexAcpConfig.js";')
sub('src/setup.ts', r'      let configuredCommand: string \| null;\n      try \{\n        configuredCommand = adapter\.id === "codex" && resolveCodexRuntime\(env\) === "acp"\n          \? resolveCodexAcpCommand\(env\)\n          : resolveProviderExecutable\(adapter\.id, env\);\n      \} catch \{\n        return \[\];\n      \}', '      const configuredCommand = adapter.id === "codex"\n        ? resolveCodexAcpCommand(env)\n        : resolveProviderExecutable(adapter.id, env);')
replace('src/interactiveCliAuth.ts', 'import { resolveCodexAcpCommand, resolveCodexRuntime } from "./providers/codexAcpConfig.js";', 'import { resolveCodexAcpCommand } from "./providers/codexAcpConfig.js";')
sub('src/interactiveCliAuth.ts', r'    if \(provider === "codex"\) \{\n      try \{\n        const runtime = resolveCodexRuntime\(env\);\n        const command = runtime === "acp"\n          \? resolveCodexAcpCommand\(env\)\n          : resolveProviderExecutable\(provider, env\);\n        return commandExists\(command\);\n      \} catch \{\n        return false;\n      \}\n    \}', '    if (provider === "codex") return commandExists(resolveCodexAcpCommand(env));')

# Qualification runtime identity is fixed to ACP for Codex.
replace('src/providers/qualification.ts', 'import { isCodexAcpRuntime, resolveCodexAcpCommand, resolveCodexRuntime } from "./codexAcpConfig.js";', 'import { resolveCodexAcpCommand } from "./codexAcpConfig.js";')
replace('src/providers/qualification.ts', '  if (providerId === "codex" && isCodexAcpRuntime("codex", env)) return "default";', '  if (providerId === "codex") return "default";')
replace('src/providers/qualification.ts', '  "AGENT_BRIDGE_CODEX_RUNTIME",\n', '')
sub('src/providers/qualification.ts', r'  if \(providerId === "codex" && resolveCodexRuntime\(env\) === "acp"\) \{\n    return resolveCodexAcpCommand\(env\);\n  \}', '  if (providerId === "codex") return resolveCodexAcpCommand(env);')
replace('src/providers/qualification.ts', '  return providerId === "codex" ? resolveCodexRuntime(env) : "native";', '  return providerId === "codex" ? "acp" : "native";')
replace('src/providers/qualification.ts', '  /** Codex ACP vs legacy. Omitted on pre-ACP records (treated as legacy). */', '  /** Runtime identity used to prevent evidence from cross-qualifying another transport. */')

# Runtime inspection exposes only ACP sessions and adapter availability.
replace('src/runtimeInspector.ts', 'import { resolveCodexAcpCommand, resolveCodexRuntime } from "./providers/codexAcpConfig.js";', 'import { resolveCodexAcpCommand } from "./providers/codexAcpConfig.js";')
sub('src/runtimeInspector.ts', r'function projectCodexSession\(.*?\n\}\n\nfunction sessions', '''function projectCodexSession(db: Database.Database, chatKey: string) {\n  let binding: Row | undefined;\n  if (hasTable(db, "acp_session_bindings")) {\n    binding = db.prepare(\n      `SELECT created_at, updated_at FROM acp_session_bindings WHERE conversation_id=? AND provider_id=?`,\n    ).get(chatKey, "codex") as Row | undefined;\n  }\n  const stale = Boolean(binding && isStaleTimestamp(binding.updated_at));\n  const active = Boolean(binding) && !stale;\n  return {\n    provider: "codex" as const,\n    runtime: "acp" as const,\n    exists: active,\n    createdAt: active ? text(binding?.created_at, 40) : null,\n    updatedAt: active ? text(binding?.updated_at, 40) : null,\n    source: "acp_session_bindings",\n    ...(stale ? { reasonCode: "stale_binding" } : {}),\n  };\n}\n\nfunction sessions''', count=1)
replace('src/runtimeInspector.ts', '? projectCodexSession(db, s.chatKey!, row, env)', '? projectCodexSession(db, s.chatKey!)')
sub('src/runtimeInspector.ts', r'    if \(adapter\.id === "codex"\) \{\n      try \{\n        if \(resolveCodexRuntime\(env\) === "acp"\) \{\n          const adapterPath = resolveCodexAcpCommand\(env\);\n          if \(!isExecutable\(adapterPath\)\) \{\n            availability = "unavailable";\n            availabilityReasonCode = "acp_adapter_missing";\n          \}\n        \}\n      \} catch \{\n        availability = "unavailable";\n        availabilityReasonCode = "invalid_codex_runtime";\n      \}\n    \}', '    if (adapter.id === "codex" && !isExecutable(resolveCodexAcpCommand(env))) {\n      availability = "unavailable";\n      availabilityReasonCode = "acp_adapter_missing";\n    }')

# Health always evaluates the managed ACP adapter for Codex.
replace('src/health/plugins/self.ts', 'import { resolveCodexRuntime } from "../../providers/codexAcpConfig.js";\n', '')
sub('src/health/plugins/self.ts', r'function isCodexAcpSelected\(.*?\n\}\n\n', '', count=1)
replace('src/health/plugins/self.ts', '    const acpCodex = isCodexAcpSelected();\n    let runtimeVersions: ReturnType<typeof readInstalledProviderVersions> | undefined;\n    if (acpCodex) {\n      runtimeVersions = readInstalledProviderVersions();\n      checks.push(inspectBundledCodexAcp(runtimeVersions));\n    }', '    const runtimeVersions = readInstalledProviderVersions();\n    checks.push(inspectBundledCodexAcp(runtimeVersions));')

# ACP process owns terminal semantics; native Codex success parsing is obsolete.
sub('src/cliSuccessfulExitValidation.ts', r'import \{\n  CodexUncertainCompletionError,\n  hasUsableFinalResponse,\n  parseResult as parseCodexResult,\n\} from "\.\/providers\/codexRuntime\.js";\n', '')
replace('src/cliSuccessfulExitValidation.ts', 'const CODEX_MISSING_CUSTOM_TOOL_OUTPUT = "Custom tool call output is missing for call id:";\n', '')
sub('src/cliSuccessfulExitValidation.ts', r'export class CodexMissingToolOutputError extends Error \{.*?\n\}\n\n', '', count=1)
sub('src/cliSuccessfulExitValidation.ts', r'function validateCodexSuccessfulExit\(.*?\n\}\n\n', '', count=1)
replace('src/cliSuccessfulExitValidation.ts', '  if (bot === "codex") return validateCodexSuccessfulExit(output);\n', '')

# Remove rollout env propagation; adapter command/args remain supported overrides.
for path in ['scripts/install.sh', 'scripts/agent-bridge-install.py', '.env.codex.example', '.env.discord-interactive.example', '.env.interactive.example']:
    text = read(path)
    text = re.sub(r'.*AGENT_BRIDGE_CODEX_RUNTIME.*\n', '', text)
    write(path, text)

# Update live docs and comments; keep historical ADR/research documents intact.
for path in ['docs/ACP.md', 'docs/PROVIDER-QUALIFICATION.md', 'docs/runtime-inspection.md', 'src/providers/apiKeyAuth.ts', 'src/providers/codexAcpAuthProbe.ts', 'src/providers/codexAcpRuntime.ts', 'src/providers/types.ts', 'src/promptWrapping.ts']:
    text = read(path)
    text = text.replace('parallel ACP-backed Codex path', 'ACP-backed Codex path')
    text = text.replace('Parallel ACP-backed Codex runtime', 'ACP-backed Codex runtime')
    text = text.replace('The legacy `codexRuntime.ts` path remains selectable.', 'Codex execution is ACP-only.')
    text = text.replace('src/providers/codexRuntime.ts and\n', '')
    text = text.replace('src/providers/codexRuntime.ts, ', '')
    write(path, text)

# Remove the legacy runtime itself.
(ROOT / 'src/providers/codexRuntime.ts').unlink()

# Promotion regression no longer needs the removed selector.
path = 'test/issue737CodexAcpPromotion.red.test.ts'
text = read(path)
text = re.sub(r'const originalRuntime.*?\n', '', text)
text = text.replace('  if (originalRuntime === undefined) delete process.env.AGENT_BRIDGE_CODEX_RUNTIME;\n  else process.env.AGENT_BRIDGE_CODEX_RUNTIME = originalRuntime;\n', '')
text = text.replace('    delete process.env.AGENT_BRIDGE_CODEX_RUNTIME;\n', '')
write(path, text)

print('issue 737 source migration applied')
