# Agent Bridge — Agent Instructions

## Mandatory instruction order

1. Read this file first.
2. Read `AGENTS.repository.md` before planning, editing, reviewing, merging, releasing, or deploying.
3. Read any more-specific `AGENTS.md` that applies to the files being changed.

`AGENTS.repository.md` preserves the detailed repository, runtime, TDD, worker, service, deployment, and recovery rules. Those rules remain mandatory.

The proportionality rules in this file take precedence where a detailed rule would otherwise require process that is not justified by the actual change. They do **not** weaken explicit security boundaries, production-mutation controls, data-integrity requirements, merge authority, deployment authority, or user instructions.

## Proportional change policy

### Start with the smallest coherent outcome

Implement the least invasive vertical change that satisfies the user-visible intent and preserves existing behaviour outside the approved scope.

Before proposing a new abstraction, database table, repository, service, queue, workflow engine, resolver, supervisor, permission framework, evidence format, approval gate, or child issue, identify the current owner and explain with concrete evidence why it cannot safely support the requirement. Without that evidence, extend the existing owner.

For worker changes, prefer the existing `AdvisorService`, provider chains, handler map, work queue, job phase data, workspaces, TDD guards, process supervisor, PR lifecycle, and merge gate.

Do not build infrastructure for hypothetical later phases. A default-off vertical path is preferable to a complete speculative framework.

### Keep issues and PRs vertically complete

Default to one issue and one PR for one independently useful outcome. Split work only when a part:

- delivers independent user or operator value;
- has a materially different owner or security boundary;
- requires a separate schema, deployment, or production authorisation;
- can merge safely without depending on unfinished sibling infrastructure; or
- is too large to review even after removing speculative scope.

Do not create serial child issues merely to separate internal phases, model roles, test classes, review stages, or possible future capabilities.

If a proposal needs more than two new child issues or more than one new persistent/runtime abstraction, perform a simplification pass before mutation. Record what can be reused, removed, deferred, or combined.

### Diagnose fixes before expanding them

For defects, CI failures, review findings, and regressions:

1. reproduce the observed failure at the smallest authoritative boundary;
2. identify the root cause and affected sibling paths;
3. make the smallest coherent correction;
4. add only the regression coverage needed for the actual bug class; and
5. avoid unrelated cleanup, redesign, renaming, or policy expansion.

A review comment is evidence about a defect, not automatic authority to broaden the architecture. Fix the finding without converting every edge case into a new subsystem or permanent gate.

### Refactor only with a present need

Refactors must preserve observable behaviour unless behaviour change is explicitly approved. Extract or redesign only when current duplication, coupling, testability, ownership, or defect evidence justifies it.

Do not add extension points, generalized policy languages, pluggable frameworks, durable metadata, or compatibility layers solely because they might be useful later.

### Use proportional TDD and commit structure

Behaviour changes and bug fixes require an observed failing test or an existing authoritative reproduction before implementation. The failure must be for the intended reason.

Do not manufacture red tests for documentation-only edits, comment corrections, metadata-only changes, mechanical refactors with proven unchanged behaviour, or review repairs already reproduced by an existing test.

Separate red and green commits when they provide meaningful, independently reviewable evidence. Do not create artificial commits, rewrite useful history, or block a small fix solely to satisfy commit choreography.

Test depth follows the highest risk actually changed. Do not require migration, rollback, concurrency, restart, appliance, deployment, or full lifecycle matrices when those boundaries are unchanged.

### Scale evidence and review to risk

For a normal source-only change with no schema, deployment, production, credential, permission, queue, or irreversible external-side-effect change, the default completion path is:

`focused tests → affected tests → repository-required checks → exact-head CI → one exact-head review → human merge`

Add specialized qualification only when triggered by the diff:

- schema or persisted-state change → migration, preservation, reopen, and rollback evidence;
- queue, lease, cancellation, or process lifecycle change → focused lifecycle and race coverage;
- authentication, credentials, permissions, or trust-boundary change → focused security-boundary coverage;
- deployment, service, artifact, or production-path change → guarded release and rollback qualification;
- irreversible external mutation → idempotency and postcondition evidence.

Do not demand appliance rollout, production staging, copied-database cohorts, byte-exact restoration, repeated serial full-suite runs, multiple reviewer identities, or independent reviews for every internal phase unless the actual change triggers those risks.

### Prevent approval inflation

Branch-local, reversible implementation, testing, CI reruns, review repair, and read-only evidence gathering do not require repeated permission.

Normal delivery uses one explicit exact-head merge approval. A separate deployment approval is required only when deployment or production mutation is actually requested and qualified.

Do not turn each verification step into an approval gate. Do not ask again for an approval that already covers the unchanged operation and exact identity.

### Replace superseded requirements instead of accumulating them

When review or new evidence changes the design, revise or remove obsolete acceptance criteria, tests, child issues, and gates. Do not keep old and new approaches simultaneously “for safety.”

Before closing review, check for contradictory, duplicated, stale, or no-longer-triggered requirements. The current approved contract must be understandable without reading a chronology of abandoned designs.

### Report decisions compactly

Record:

- the intended outcome;
- material assumptions and non-goals;
- the smallest implementation boundary;
- checks actually triggered by the change;
- blockers or residual risks; and
- the next human decision, if one exists.

Do not duplicate the same evidence across issue bodies, PR descriptions, comments, and approval packages. Link to one canonical record and report only material changes.

## Stop conditions

Stop and request human direction when the smallest safe implementation cannot be determined because of an unresolved product decision, conflicting authority, destructive production action, secret exposure, irreversible mutation, or materially changed approved identity.

Do not stop merely because more verification is possible, because a model suggested a broader design, or because a hypothetical future requirement is unresolved.
