# Agent Role Assignment Configuration

## Status

Slice 1 of Issue #159 is implemented by Issue #161. Agent Bridge can now validate, persist, version, and report explicit desired role assignments, but the feature is deliberately dormant:

- desired assignments are reported as `configured_dormant`;
- role routing is disabled;
- existing `WORKER_CLI_CHAIN`, `WORKER_CODE_CLI_CHAIN`, and `WORKER_SCRIBE_CLI_CHAIN` values remain the effective execution policy;
- capability resolution, permission profiles, automatic selection, recommended selection, review-target selection, and later-slice lifecycle behaviour are not active.

The remainder of this document distinguishes the current Slice 1 contract from the later target state defined by PR #160 and ADR-005.

## Current Slice 1 configuration

The worker accepts one optional JSON environment variable and one optional scope variable:

- `WORKER_ROLE_ASSIGNMENTS_JSON` — an array containing exactly one assignment for each public role;
- `WORKER_ROLE_ROUTING_ENABLED` — default-off activation for the existing orchestrated workflow's read-only Technical Lead plan and final-review checkpoints. When enabled, the persisted `technical_lead` primary/fallback chain is authoritative and invalid configuration fails closed.
- `WORKER_ROLE_ASSIGNMENT_SCOPE` — a bounded workspace/scope identifier; defaults to `worker:default`. Secret-, prompt-, and repository-content-shaped scope values fail closed before database opening.

Example:

```json
[
  {
    "role": "technical_lead",
    "selection": "manual",
    "primary": { "cli": "claude", "model": "claude-fable-5" },
    "fallbacks": [{ "cli": "codex", "model": "gpt-5.6-sol" }]
  },
  {
    "role": "code_worker",
    "selection": "manual",
    "primary": { "cli": "codex", "model": "gpt-5.6-sol" },
    "fallbacks": [{ "cli": "claude", "model": "claude-sonnet-5" }]
  },
  {
    "role": "documentation_steward",
    "selection": "manual",
    "primary": { "cli": "antigravity", "model": "gemini-3.1-pro" },
    "fallbacks": []
  }
]
```

The parser is fail-closed. It rejects:

- missing, duplicate, or unknown roles;
- a mode name presented as a role;
- unknown fields;
- credential-, prompt-, or repository-content-shaped fields or scope values;
- credential-shaped values;
- unbounded or malformed scope, CLI, or model identifiers;
- duplicate primary/fallback targets;
- more than four fallbacks for one role.

The persisted record contains only scope, revision, source, dormant status, deterministic idempotency identity, bounded CLI/model identifiers, selection labels, fallbacks, and timestamps. It does not store tokens, API keys, credentials, prompts, repository content, capability results, or permission profiles.

### Startup and persistence

Role configuration is parsed before the worker opens its production database. Invalid configuration therefore fails before role persistence.

A valid explicit configuration is persisted through the existing `BridgeDb` compatibility façade and the sole role-assignment repository. Repeating the identical configuration returns the same revision. A changed valid configuration creates the next revision for the same scope.

Production startup remains strict: ordinary services accept only the current schema version. Schema version 2 databases must be upgraded to schema version 3 through the guarded rollout helper before a schema-3 worker is started.

### Current status surface

`/chain` preserves its legacy output when no role assignment revision exists. When a revision exists it additionally reports:

- `Role assignments: configured_dormant`;
- desired revision and configuration source;
- desired primary and fallback targets for each role;
- `Role routing: disabled`;
- the effective legacy interactive, code, and scribe chains.

Desired configuration is never labelled effective. No assignment value is consulted by an existing job handler or interactive dispatch path.

## Roles and modes

Agent Bridge exposes exactly three configurable workspace roles:

- `technical_lead`;
- `code_worker`;
- `documentation_steward`.

Modes are not separately configurable roles.

Technical Lead modes:

- `requirements`;
- `issue_validation`;
- `issue_authoring`;
- `decomposition_review`;
- `planning`;
- `planning_repair`;
- `executor_guidance`;
- `implementation_review`;
- `operations_review`;
- `pr_readiness`.

Code Worker modes:

- `scan`;
- `investigate`;
- `red`;
- `green`;
- `repair`;
- `verify`.

Documentation Steward modes:

- `impact`;
- `author`;
- `validate`;
- `maintenance`.

Scanner is a Code Worker mode. Reviewer, operations, planning, decomposition review, and readiness are Technical Lead modes.

## Target-state assignment model — later slices

The following richer model is the canonical target state, not the current Slice 1 persisted schema:

```yaml
roles:
  technical_lead:
    selection: automatic | recommended | manual
    primary:
      cli: claude
      model: claude-fable-5
    fallbacks:
      - cli: codex
        model: gpt-5.6-sol
    permission_profile: advisor_read_only
    review_preference: separate_from_code_worker_role
    max_logical_calls: 4
    timeout_ms: 120000

  code_worker:
    selection: automatic | recommended | manual
    primary:
      cli: codex
      model: <coding-model>
    fallbacks:
      - cli: claude
        model: <coding-model>
    permission_profiles:
      scan: repository_read_only
      investigate: repository_read_only
      red: test_only_mutation
      green: worktree_mutation
      repair: bounded_worktree_mutation
      verify: verification_only

  documentation_steward:
    selection: automatic | recommended | manual
    primary:
      cli: agy
      model: <documentation-model>
    fallbacks:
      - cli: claude
        model: <writing-model>
    permission_profiles:
      impact: repository_read_only
      author: documentation_only
      validate: repository_read_only
      maintenance: documentation_only
```

A CLI name without a model is not a complete explicit assignment.

## Target-state assignment modes — later slices

Slice 1 persists the `automatic`, `recommended`, and `manual` labels but does not execute their resolution behaviour.

### Automatic

Later slices rank authenticated targets using verified capability metadata and workspace policy.

### Recommended

Later slices propose assignments. The platform displays reasoning tier, coding/documentation suitability, structured-output support, permission compatibility, cost tier, fallback coverage, role separation, and model-diversity metadata before the user accepts them.

### Manual

Later slices validate selected primary and fallback CLI/model targets against role capability and permission contracts before activation.

## Target-state capability metadata — later slices

Each discovered target will record:

```yaml
cli: codex
model: <model-id>
authenticated: true
capabilities:
  reasoning_tier: frontier | strong | standard
  coding_tier: strong | standard | unsuitable
  documentation_tier: strong | standard | unsuitable
  structured_output: verified | unverified | failed
  read_only_mode: enforced | bridge_wrapped | unavailable
  context_tier: large | medium | small
  cost_tier: high | medium | low
  latency_tier: high | medium | low
last_probe:
  status: passed | failed | stale
  checked_at: <timestamp>
```

CLI-supported discovery is preferred. Static provider metadata and manually entered model IDs are supported where discovery is unavailable, but a bounded validation probe is required before later activation.

## Target-state automatic ranking — later slices

- **Technical Lead:** reasoning quality, reliable structured output, read-only evidence compatibility, then cost and latency.
- **Code Worker:** coding success and repository-tool compatibility, then cost and latency.
- **Documentation Steward:** document quality, context capacity, structured output, then cost.

Fallback preserves required capability before optimising cost.

## Single-CLI and single-model target state — later slices

When only one CLI is authenticated, later resolution chooses a model separately for each role. When only one model is available, it may serve every role and preserve the target-state role/authority boundary, but Issue #161 classifies actual delivery independence as `non_independent` and holds the workflow for a genuinely independent frontier reviewer or human decision.

- Technical Lead: strongest suitable reasoning model;
- Code Worker: strongest cost-effective coding model;
- Documentation Steward: strongest writing or long-context model.

Every role uses a separate session, role prompt, permission profile, call budget, and audit record.

## Single-model operation

When only one model is available, it may serve every role. The status surface reports:

```text
Role separation: preserved
Model diversity: unavailable
Actual review independence: non_independent
Single-provider dependency: active
```

Role separation remains preserved, but a single-model fresh session does not satisfy Issue #161's genuinely independent final-review gate. The workflow stays held for a different frontier reviewer or human decision.

## Review target resolution

The configured Technical Lead advisor target owns implementation, operations, readiness, and final review reasoning. Review independence is established by role and authority separation from the mutating Code Worker.

The target-state role policy still requires all of the following review-authority controls:

1. the reviewer role is `technical_lead`;
2. the Technical Lead did not author or modify the implementation under review;
3. the review invocation is read-only and has no mutation authority;
4. the review is a fresh invocation bound to the exact `subject_head_sha`.

Prior read-only Technical Lead requirements, planning, decomposition, guidance, or review work does not disqualify the reviewer. The mutating Code Worker cannot review its own implementation. A head change requires a fresh Technical Lead review invocation. For Issue #161 delivery readiness, these controls are necessary but not sufficient: the final reviewer must also be genuinely independent, and a same-model fresh session is recorded as `non_independent`.

Every review records:

- `required_independence`;
- `actual_independence`;
- reviewer role and target;
- whether the reviewer authored or modified the reviewed implementation;
- whether mutation authority was available;
- whether the review was a fresh exact-head invocation;
- whether the independence gate is satisfied.

The platform does not expose a fourth Reviewer role.

## Phase and exact-head stability

A later active logical call snapshots its role, mode, assignment revision, target, permission profile, prompt/skill identity, and subject revision where applicable.

Verification, implementation review, operations review, documentation, and readiness bind to one exact `subject_head_sha`. A code-changing repair invalidates later evidence for the old head; target reassignment or fallback does not permit reuse of stale evidence.

## Degraded states

Role status includes:

- requested assignment;
- effective primary and fallback;
- configuration source;
- authentication state;
- model-probe freshness;
- missing capabilities;
- model-diversity state;
- required and actual role-separation review state;
- whether workspace policy permits execution.

No fallback or degraded state is silent.

## Compatibility

Legacy `WORKER_CLI_CHAIN`, `WORKER_CODE_CLI_CHAIN`, and `WORKER_SCRIBE_CLI_CHAIN` remain authoritative in Slice 1. Explicit role configuration is desired state only and cannot override or participate in dispatch.

A later activation slice may make role configuration authoritative only after its own human gate, routing tests, capability-resolution implementation, and operational qualification.

## Platform requirements — later slices

The hosted platform provides:

- authenticated CLI inventory;
- available-model inventory and probe status;
- automatic, recommended, and manual assignment controls;
- primary and fallback selection;
- per-role budget and timeout controls;
- role-separation review policy and model-diversity metadata;
- desired and exact applied revision status;
- effective/degraded/rejected/pending role status;
- a non-mutating role test action;
- audit history without secrets or raw unrestricted prompts.

Desired configuration is not represented as effective until the appliance reports the matching applied revision.

Slice 1 does not add Platform transport or mutate Platform state.
