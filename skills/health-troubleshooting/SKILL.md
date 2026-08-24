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
- Reuse established local scripts, deployment helpers, service controls, and qualification paths instead of inventing parallel mechanisms.
- If the repair requires authority the Run does not have, stop at a concrete recommended action.
- If local repair is inappropriate and recovery requires infrastructure, backups, or another deployment-owned capability, report that boundary and follow only recovery instructions explicitly supplied by the current deployment/operator. Do not invent a control-plane flow, obtain infrastructure credentials, or execute a restore merely because recovery may exist elsewhere.

## 5. Verify recovery

- Re-run the directly relevant health check or inspect the authoritative recovery signal.
- Verify the affected boundary, not merely that a command exited successfully.
- If recovery is not observed, keep the original incident open and return to evidence gathering.
- If recovery was performed outside Agent Bridge, require an authoritative completion signal and then re-qualify the affected local boundary before reporting success.

## Report

Return a compact report with: observation, evidence, inference/root cause, action taken or recommended, verification, and any remaining risk. Do not expose hidden reasoning, credentials, raw provider identifiers, or raw protocol payloads.
