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

- Claude: use Claude's native `claude mcp` commands or its normal user/project MCP configuration for the intended scope.
- Codex: use native `codex mcp` commands / Codex's native MCP entries.
- Agy `1.1.19` was qualified with native `agy mcp add/remove/list/enable/disable`; its configuration was observed at `~/.gemini/config/mcp_config.json`. The earlier Agy `1.1.12` no-MCP result is historical, not a current capability rule.
- Grok Build `1.0.5` was qualified with native `grok mcp add/remove/list/enable/disable/doctor`; its configuration was observed at `~/.grok/config.toml`. Grok remains opt-in.

Grok headless MCP tool use requires trusted execution so its native `--always-approve` behavior is available. Prefer the normal shared execution-mode policy; when an explicit Grok override is required, use `GROK_EXECUTION_MODE=trusted`. Do not bypass the policy by changing `NODE_ENV`, and do not weaken the safe default for unrelated Runs.

Do not create a universal Agent Bridge MCP configuration file. Do not use Claude's exclusive enterprise managed-MCP file as the normal Agent Bridge path because it can suppress unrelated user/project MCP servers.

Preserve unrelated user-managed MCP registrations. Update or remove only the named server the user asked Agent Bridge to manage.

## Credentials

Never write a credential value into MCP configuration, Skill content, logs, screenshots, qualification evidence, or user-visible output.

Configure the MCP to reference an environment-variable name where the provider/server supports it. On managed Farstax workspaces, use the existing Platform workspace Secrets path to supply that environment variable to provider CLI runs.

Current Platform workspace Secrets are available to provider tasks. They are appropriate for user-owned API/MCP credentials, but they are not a hidden-from-agent boundary. Credentials that must remain hidden from the provider/model require a scoped local service such as OpenConnector rather than plaintext injection into the CLI environment.

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

Active-tool cancellation has not yet been separately qualified for MCP. Keep MCP operations bounded and do not make long-running MCP work a production dependency until cancellation is re-proved through the existing Agent Bridge supervision/fencing path.

## Playwright MCP

For headless web UI work, prefer the qualified Playwright MCP path when no stronger provider-native browser path has itself been qualified.

The evidence captured for issue #554 qualified Playwright MCP `0.0.79` with headless Chromium. On a managed host, keep that version pinned until a newer version is requalified. Run it headlessly and isolate task browser state where practical; do not disable the Chromium sandbox unless the environment specifically requires and qualifies that exception.

Playwright MCP is a tool boundary, not a security sandbox. Keep test credentials scoped, prefer localhost/test/staging, and do not expose production sessions merely to obtain visual evidence.

## Remove or update

Use the provider's native MCP commands/configuration to change only the named registration. Verify the final provider-visible state and remove temporary test fixtures. Do not rewrite whole provider configuration files when a native targeted command exists.
