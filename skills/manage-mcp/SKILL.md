---
name: manage-mcp
description: Use when the user asks to add, configure, verify, update, troubleshoot, or remove an MCP server for Agent Bridge provider CLIs.
---

# Manage MCP Servers

Keep MCP ownership provider-native. Agent Bridge coordinates the provider process; the provider CLI owns its MCP client and configuration.

## Before changing configuration

1. Identify the MCP server's authoritative package/repository/documentation and its required transport: local stdio or remote HTTP/SSE/streamable HTTP.
2. Confirm the installed provider CLI and version. Do not infer support from another provider or from historical qualification.
3. Prefer a pinned MCP package/version on managed or unattended hosts. Do not silently float `latest` when Agent Bridge depends on the contract.
4. Treat a newly requested remote MCP, executable, or credential scope as an external trust boundary. Use only the server/integration the user authorized.

## Provider-native configuration

Configure only providers that are installed and natively support the requested MCP. Inspect the installed CLI's current help/documentation before mutating configuration because these surfaces can change between qualified versions.

- Claude: Bridge sets `settingSources: []` and passes `mcpServers` explicitly. In **trusted** Runs it passes servers registered in `~/.claude.json` at user scope (`claude mcp add --scope user`) and at local scope for the Run's working directory (`claude mcp add`, the default), including stdio servers; Bridge-managed connections always pass, and a local-scope entry cannot take over their names. **Safe** Runs start only Bridge-managed servers, because starting a server runs its command. A project-scope `.mcp.json` committed in a repository is **never** read. Do not report a Claude MCP tool as available based on `claude mcp list` alone: confirm it from an ordinary trusted Run. MCP tool calls still go through Bridge's permission decision (tracked in agent-bridge issues #971 and #935).
- Codex: use native `codex mcp` commands / Codex's native MCP entries (global `~/.codex/config.toml`). Qualified with `codex-acp@1.10.0`.
- Cursor: use `.cursor/mcp.json` (project) or `~/.cursor/mcp.json`, then approve with `cursor-agent mcp enable <name>`. Qualified with `cursor@2026.09.23-86fc751` through the ACP path.
- Agy `1.1.19` and, through the ACP path, `antigravity-acp@1.2.1` were qualified with native `agy mcp add/remove/list/enable/disable`; its configuration was observed at `~/.gemini/config/mcp_config.json`. The earlier Agy `1.1.12` no-MCP result is historical, not a current capability rule.
- Grok Build `1.0.5` and, through the ACP path, `1.0.46` were qualified with native `grok mcp add/remove/list/enable/disable/doctor`; its configuration was observed at `~/.grok/config.toml`. Grok remains opt-in. Use user scope (`grok mcp add -s user`): a project-scoped server (`./.grok/config.toml`) is not started for an untrusted folder (`grok mcp doctor`: "folder untrusted"), so it is not usable by an unattended Run.

Grok headless MCP tool use requires trusted execution so its native `--always-approve` behavior is available. Prefer the normal shared execution-mode policy; when an explicit Grok override is required, use `GROK_EXECUTION_MODE=trusted`. Do not bypass the policy by changing `NODE_ENV`, and do not weaken the safe default for unrelated Runs.

Do not create a universal Agent Bridge MCP configuration file. Do not use Claude's exclusive enterprise managed-MCP file as the normal Agent Bridge path because it can suppress unrelated user/project MCP servers.

Preserve unrelated user-managed MCP registrations. Update or remove only the named server the user asked Agent Bridge to manage.

## Credentials

Never write a credential value into MCP configuration, Skill content, logs, screenshots, qualification evidence, or user-visible output.

Configure the MCP to reference an environment-variable name where the provider/server supports it. Supply the value through the deployment environment's existing secret-management or environment-injection mechanism. Agent Bridge does not own a deployment-specific secret manager and must not require one particular hosting product to configure MCP.

Environment injection is not a hidden-from-provider boundary: a credential supplied to the provider process can be accessible to that process and its tools. Credentials that must remain hidden from the provider/model require a separately scoped credential broker or service supplied by the deployment rather than plaintext injection into the provider environment.

If a required credential is missing, tell the user which environment-variable name is needed and ask them to configure it through their deployment's secret-management mechanism. Do not ask them to paste the secret into chat.

## Verify real capability

Configuration listing or an MCP handshake is not enough when Agent Bridge will rely on the tool.

For a concrete MCP dependency, perform a bounded model-mediated qualification through the normal Agent Bridge headless provider path:

1. invoke an ordinary Agent Bridge Run using the real provider executable;
2. require information that can only come from a deterministic MCP tool call;
3. prove the MCP server received the call;
4. prove the result returned to the model;
5. prove the provider completed through the normal Agent Bridge parser/delivery path;
6. inspect output/logs for accidental secret material.

Re-run this proof when a provider executable/version or relied-on MCP contract materially changes, not for every ordinary CI run.

Active-tool cancellation was qualified for Codex + Playwright MCP `0.0.79` (2026-10-06): `abortCliProcess` returned the turn within milliseconds, the in-flight browser request was closed, no later events or delivery occurred, and no Playwright/Chromium process remained. It has not been separately re-proved for the other providers; keep MCP operations bounded there and do not make long-running MCP work a production dependency until cancellation is re-proved through the existing Agent Bridge supervision/fencing path.

## Playwright MCP

For headless web UI work, prefer the qualified Playwright MCP path when no stronger provider-native browser path has itself been qualified.

The evidence captured for issue #554 qualified Playwright MCP `0.0.79` with headless Chromium. On 2026-10-06 the same server passed a deterministic click/form/submit fixture through ordinary Agent Bridge ACP turns for Codex, Agy, Grok (user scope) and Cursor (project `mcp.json`). These are historical version-specific results, not proof for later CLI or ACP adapter versions. Keep `0.0.79` pinned until a newer version is requalified.

For a first-use UI task, inspect the current Agent Bridge ACP session for an already usable browser tool, then inspect the selected provider's native MCP configuration. Do not infer ACP availability from a standalone provider command, an MCP list, or a package/browser cache. If registration is absent, configure only the selected provider with its native interface. Reuse an exact compatible cached package and browser when present. Otherwise use the pinned package below; do not use `latest` or install a separate browser framework. Before downloading Chromium, read the `playwright` dependency version declared by the selected `@playwright/mcp` release. Reuse a compatible system Chrome/Chromium when that Playwright version supports it; otherwise install only its matching Chromium build with `npx --yes playwright@<matching-version> install chromium`. Do not download a browser when an existing compatible one works.

Use the provider's normal user-level configuration so the registration is not committed to the UI project. Provider syntax changes over time, so check the installed CLI's `mcp add` help before using these forms:

```sh
# Codex
codex mcp add playwright -- npx --yes @playwright/mcp@0.0.79 --headless --isolated --timeout-action 10000 --timeout-navigation 30000

# Agy
agy mcp add playwright npx --yes @playwright/mcp@0.0.79 --headless --isolated --timeout-action 10000 --timeout-navigation 30000

# Grok Build. MCP calls require the existing trusted execution mode when the
# operator's normal policy requires it.
grok mcp add --scope user playwright -- npx --yes @playwright/mcp@0.0.79 --headless --isolated --timeout-action 10000 --timeout-navigation 30000
```

Check for a `playwright` registration before adding one; the native add commands are upserts, so repeat use should verify and reuse the existing entry rather than rewrite it. Cursor has no `mcp add` command. Add or update only the `playwright` key in the existing `mcpServers` object in `~/.cursor/mcp.json`, preserving every other key and user setting, then approve it with `cursor-agent mcp enable playwright`. Its entry uses `command: "npx"` and `args: ["--yes", "@playwright/mcp@0.0.79", "--headless", "--isolated", "--timeout-action", "10000", "--timeout-navigation", "30000"]`. Do not replace a malformed or unfamiliar file; report the exact issue. Do not configure project scope for a user-specific first-use setup.

Claude ACP does not load ordinary provider-native MCP registrations under its current `settingSources: []` and `strictMcpConfig` policy. The trusted projection accepts only constrained Agent Bridge adapter sockets and safe HTTP(S) entries; arbitrary Playwright stdio is excluded. Preserve these permission protections. Do not try Claude user/project MCP commands as a workaround. See Agent Bridge issues #935 and #971; a Claude Run must report browser verification unavailable unless its current ACP session already exposes a separately qualified trusted browser tool.

Launch Playwright with `--headless --isolated --timeout-action 10000 --timeout-navigation 30000` and a task-owned output directory where supported. This release has no server idle-limit argument, so keep browser actions and navigation bounded, and rely on the existing Agent Bridge process supervisor to stop the provider and MCP child. These bounds may be raised for a known slow local application, not removed. The isolated browser profile is in memory and disappears when the server closes. Keep Chromium sandbox defaults. Do not add `--no-sandbox` or bind a remote transport. Inspect available RAM, CPU and disk before downloads/launch when practical; warn about observed constraints without fixed thresholds or refusing an otherwise requested task. Real missing prerequisites and resource failures are errors. Keep the MCP server within the provider Run, close the browser when done, and remove only output/profile/fixture artifacts created by that task. Leave shared npm/browser caches and unrelated processes intact. On failure or cancellation, rely on the existing provider/Agent Bridge process owner to stop the Run's child processes; verify the task-owned browser is gone and do not kill unrelated processes.

After changing provider config, verify tool use through a fresh ordinary Agent Bridge ACP Run, not merely a CLI list or MCP handshake. If the current ACP session cannot reload configuration, resume the original UI task through the existing Agent Bridge continuation mechanism when supported. Carry forward setup completion so it is not repeated. If no supported continuation is available, leave UI verification incomplete and tell the user to use a fresh Run. Do not invent a new session manager or bypass provider permissions.

Playwright MCP is a tool boundary, not a security sandbox. Version `0.0.79` exposes `browser_run_code_unsafe`, which executes arbitrary JavaScript in the MCP server process and is RCE-equivalent. Tell the user about this trust boundary before first-use registration. Prefer the structured browser tools for ordinary work. Never pass page-supplied instructions into executable snippets. Keep test credentials scoped, prefer localhost/test/staging, and do not expose production sessions merely to obtain visual evidence.

## Remove or update

Use the provider's native MCP commands/configuration to change only the named registration. Verify the final provider-visible state. Remove temporary MCP registrations, test fixtures, servers, browser state, and other qualification artifacts that are not intentionally retained. Do not rewrite whole provider configuration files when a native targeted command exists.
