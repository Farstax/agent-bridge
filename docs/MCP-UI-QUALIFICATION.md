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

## Managed Linux prerequisites

The qualified path does not require a desktop session or an Agent Bridge browser service. A managed Linux workspace needs:

- an authenticated, supported provider CLI running as the Agent Bridge runtime user;
- Node/npm/npx availability for a local stdio MCP package when that is the selected installation path;
- the qualified Playwright MCP version (`0.0.79` for this evidence point), pinned until a newer version is requalified;
- headless Chromium plus the system libraries required for that Chromium build, runnable by the same runtime user;
- provider-native MCP configuration visible to the runtime user's headless provider invocation;
- writable, task-scoped browser/output state where the MCP requires it.

Run Chromium headlessly. Isolate browser state for concurrent or disposable tasks where practical. Preserve the Chromium sandbox unless the host specifically requires and qualifies an exception. Do not add an X server, desktop browser session, or Bridge-owned browser lifecycle merely for this workflow.

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

## Latest provider evidence

The follow-up qualification evidence records these provider-specific results:

- Agy `1.1.19`: MCP tool use and the Playwright headless UI loop passed.
- Grok Build `1.0.5`: the MCP/UI qualification passed with
  `GROK_EXECUTION_MODE=trusted`.

Grok follows the shared per-provider execution-mode policy. Production remains
safe when no execution mode is configured, and trusted mode adds Grok's native
`--always-approve` flag. The explicit Grok variable is the normal per-provider
override, not a separate production-only safety policy. The earlier Agy `1.1.12`
observation that MCP was unsupported is historical and is superseded by the
`1.1.19` qualification.

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
