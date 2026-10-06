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

- Claude: `claude mcp` registrations (local, project `.mcp.json`, and user scope) are **not loaded** on the Agent Bridge Claude ACP path, because Bridge sets `settingSources: []` and sends no `mcpServers` (observed with `claude-acp@0.85.1`; tracked in agent-bridge issue #935). Do not report a Claude MCP tool as available on the Bridge path based on `claude mcp list` or the interactive CLI.
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

The evidence captured for issue #554 qualified Playwright MCP `0.0.79` with headless Chromium. On 2026-10-06 the same server passed a deterministic click/form/submit fixture through ordinary Agent Bridge ACP turns for Codex, Agy, Grok (user scope) and Cursor (project `mcp.json`). No provider exposes a native browser or computer-use tool on its Bridge ACP path (Claude, Codex, Agy, Grok, Cursor all lack one), and Claude has no MCP browser path today (#935). A UI task routed to Claude must report browser verification as unavailable. On a managed host, keep that version pinned until a newer version is requalified. Run it headlessly and isolate task browser state where practical; do not disable the Chromium sandbox unless the environment specifically requires and qualifies that exception.

Playwright MCP is a tool boundary, not a security sandbox. Keep test credentials scoped, prefer localhost/test/staging, and do not expose production sessions merely to obtain visual evidence.

## Remove or update

Use the provider's native MCP commands/configuration to change only the named registration. Verify the final provider-visible state. Remove temporary MCP registrations, test fixtures, servers, browser state, and other qualification artifacts that are not intentionally retained. Do not rewrite whole provider configuration files when a native targeted command exists.
