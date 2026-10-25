---
name: systematic-debugging
description: Use when investigating a bug, failure, or unexpected behaviour before proposing a fix
---

# Systematic debugging

> Adapted from the Superpowers `systematic-debugging` skill by Jesse Vincent. It is distributed under the MIT License; see `LICENSE` in this skill directory.

## Purpose

Use this process for failures, bugs, unexpected behaviour, integration problems, and performance issues. Find and explain the likely root cause before proposing a change. A workaround is not a root-cause finding.

This Skill provides investigation guidance only. It does not grant remediation authority, choose tools, create a workflow, or perform a fix. Existing Run permissions and explicit user or agent authority still govern every consequential action.

## Process

Complete each phase in order. Record evidence and keep facts separate from inferences.

### 1. Establish the symptom

- State what failed, what was expected, and who or what was affected.
- Capture the exact error, timestamps, inputs, relevant configuration, and current state.
- Protect secrets and avoid copying credentials or unrelated private data into findings.

### 2. Reproduce and characterize

- Reproduce the behaviour with the smallest safe case when possible.
- Record whether it is deterministic, intermittent, or not reproducible.
- Compare a failing case with a working case and note every meaningful difference.
- If the failure is not understood, gather more evidence before suggesting a fix.

### 3. Trace the cause

- Follow the data and control flow from the visible symptom toward its origin.
- At each component boundary, inspect what enters, what leaves, and which configuration or state crosses the boundary.
- Check recent changes, dependencies, and environmental differences.
- Stop at the earliest cause supported by evidence, not at the first convenient symptom.

### 4. Test one hypothesis

- Write one specific hypothesis and the evidence that supports it.
- Use the smallest safe observation or experiment that can disprove it.
- Change one variable at a time. Do not stack speculative patches.
- If the result does not support the hypothesis, return to evidence gathering and form a new one.

### 5. Report and verify

- Explain the evidence, likely root cause, confidence, and remaining unknowns.
- Propose the smallest justified fix and state the authority or approval it needs.
- After an authorised change, verify the original failure, the affected boundary, and relevant adjacent behaviour.
- Report what was checked, what remains uncertain, and any safe rollback or containment step.

## Stop conditions

Pause and investigate again when:

- the proposed change only hides the symptom;
- the failure cannot be reproduced or explained;
- multiple fixes are being combined;
- the evidence does not support the hypothesis;
- the requested action would expand authority or make an external change without separate authorisation.

Do not expose reasoning traces, tool payloads, credentials, raw protocol data, or unrelated environment values in the findings.
