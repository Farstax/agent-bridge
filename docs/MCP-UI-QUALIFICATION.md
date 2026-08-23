# MCP and headless UI qualification

Issue: #554

Decision: **PROCEED with provider-native MCP and Skills; do not add an Agent Bridge MCP/browser runtime.**

## Qualified environment

The bounded live spike ran on Agent Bridge `69ad46365868245f148d6c18911e15c7a12088ba` with:

- Claude Code `2.1.240`
- Codex CLI `0.149.0`
- Playwright MCP `0.0.79`

The production invocation boundary under test was:

```text
buildCliInvocation -> runSupervisedProcess -> provider parser
```

## Model-mediated MCP proof

A disposable local stdio MCP server exposed a deterministic `return_marker` tool. The marker could not be derived from the prompt or supplied manually.

| Provider | MCP configuration | Model tool call | Agent Bridge result |
| --- | --- | --- | --- |
| Claude | disposable normal `.mcp.json` configuration | `return_marker` recorded by fixture | marker parsed and returned normally |
| Codex | native `codex mcp add` configuration | `return_marker` recorded by fixture | marker parsed and returned normally |

Both providers used authenticated headless model turns. No interactive session or manual answer path supplied the marker.

This closes the earlier #286 gap: configuration/handshake evidence alone is not sufficient; the model must call the tool and its result must traverse the real Agent Bridge provider/parser path.

## Headless rendered-UI proof

Claude then used Playwright MCP with headless Chromium at `390x844` against a disposable local web app.

The test contained an oversized Save button whose defect was visual. The model:

1. invoked Playwright MCP;
2. inspected the rendered page in headless Chromium;
3. identified the oversized button;
4. edited the disposable app;
5. reloaded it;
6. inspected a second rendered screenshot;
7. confirmed the corrected button size.

No console or network defect was present. Temporary MCP registrations, fixtures, screenshots, servers, and worktrees were removed after the spike.

## Production boundary

The supported architecture is:

```text
Agent Bridge Run/process ownership
  -> native provider CLI
  -> provider-native MCP client/configuration
  -> MCP server (for UI: Playwright MCP)
  -> headless browser/tool
```

Agent Bridge does not own a common MCP configuration format, MCP proxy, browser protocol, capability registry, or second orchestration layer.

Use the `manage-mcp` Skill for provider-native installation/configuration and the `ui-engineering` Skill for rendered verification.

## Credential boundary

MCP configuration should reference environment-variable names, never persist credential values. Managed Farstax workspaces can use the existing Platform workspace Secrets path to provide those variables to provider CLI processes.

That path is suitable for user-owned API/MCP credentials but is not hidden from the provider/model. A credential that must remain hidden requires a scoped local service (for example a future OpenConnector integration), not encryption followed by plaintext injection into the CLI environment.

## Requalification triggers

Repeat bounded model-mediated qualification when Agent Bridge begins to depend on a materially changed provider executable/version or MCP contract. Do not make live provider qualification an every-commit CI gate.

A repeat proof should record:

- Agent Bridge exact commit;
- provider executable and version;
- MCP package/version and transport;
- native provider configuration mechanism;
- deterministic MCP tool call observed by the fixture;
- result returned through the normal Agent Bridge parser;
- secret-redaction check;
- pass/fail and precise failure reason.

For Playwright/UI qualification also record browser/version, headless mode, viewport, initial rendered defect, evidence of model inspection, source change, and final rendered evidence.

## Residual qualification

The #554 spike did not separately re-prove:

- MCP availability across resumed provider sessions;
- cancellation while an MCP tool call is actively running;
- Codex-specific Playwright visual inspection.

Resume persistence and active-tool cancellation should be added when provider qualification next touches these contracts; active-tool cancellation is required before relying on long-running MCP work. Codex visual qualification is only required if Agent Bridge starts depending on Codex for that specific browser contract.
