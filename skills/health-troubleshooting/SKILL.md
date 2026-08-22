---
name: health-troubleshooting
description: Use when an Agent Bridge health observation needs evidence-led diagnosis, authorised remediation, recovery guidance, and verification
---

# Health troubleshooting

Investigate health observations inside the authority already granted to the current Run. This Skill does not grant permission to restart services, deploy, change configuration, mutate repositories, restore infrastructure, or take any other consequential action.

## 1. Establish the observation

- Treat the supplied health report as an observation, not a diagnosis.
- Record the affected plugin/checks, status, timestamps, and bounded evidence.
- Re-read current state before concluding the problem still exists.

## 2. Gather current evidence

- Inspect the smallest relevant set of service status, logs, process state, configuration, storage, network, and provider qualification evidence available to the Run.
- Prefer authoritative runtime state over package metadata or assumptions.
- Protect credentials and unrelated private data.
- Keep observations separate from inference.

## 3. Identify the likely root cause

- State the leading hypothesis and the evidence for and against it.
- Test the smallest safe discriminator when evidence is incomplete.
- Do not stack speculative fixes or treat correlation as root cause.
- Report confidence and material unknowns.

## 4. Remediate only when authorised

- Prefer the smallest mechanically justified repair.
- Apply a repair only when the current Run's existing authority permits it. Skill text never expands authority.
- Reuse established scripts, deployment helpers, service controls, and qualification paths instead of inventing parallel mechanisms.
- If the repair requires authority the Run does not have, stop at a concrete recommended action.
- If evidence shows that ordinary local repair is inappropriate and the workspace is managed by a platform with backup recovery, read `references/workspace-recovery.md` and hand the customer to that platform recovery flow. Do not attempt to obtain provider credentials or execute an infrastructure restore merely because this skill knows recovery exists.

## 5. Verify recovery

- Re-run the directly relevant health check or inspect the authoritative recovery signal.
- Verify the affected boundary, not merely that a command exited successfully.
- If recovery is not observed, keep the original incident open and return to evidence gathering.
- A platform restore being accepted or started is not evidence that recovery completed; qualify the restored workspace using the managed recovery guidance before reporting success.

## Report

Return a compact report with: observation, evidence, inference/root cause, action taken or recommended, verification, and any remaining risk. Do not expose hidden reasoning, credentials, raw provider identifiers, or raw protocol payloads.
