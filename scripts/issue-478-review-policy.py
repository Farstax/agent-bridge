#!/usr/bin/env python3
from pathlib import Path
import subprocess

BRANCH = "agent/issue-478-review-phase-independence"


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    if text.count(old) != 1:
        raise RuntimeError(f"expected one target in {path}, found {text.count(old)}")
    p.write_text(text.replace(old, new, 1))


agents = Path("AGENTS.md")
text = agents.read_text()
marker = (
    "One independent review approves one exact PR head SHA after required exact-head tests and checks pass. "
    "GitHub `CI` is the authoritative full-suite regression proof for that head; independent review adds "
    "code/contract scrutiny and focused investigation rather than another routine full-suite execution.\n"
)
replacement = marker + (
    "\nReview independence is a property of the **review phase**, not necessarily of reviewer identity. The final review must be a fresh, read-only, adversarial evaluation of the pinned exact head after required checks pass. A different reviewer identity is preferred when readily available, but the same capable agent/model that previously implemented or repaired the PR may perform the final review if it explicitly ends implementation first, enters a no-mutation review phase, re-derives the judgement from the issue/acceptance contract and current diff rather than implementation intent, and records findings before making any change. Model or human diversity is metadata, not a merge gate.\n"
    "\nIf that review finds a change is required, the review phase ends before mutation. Resume implementation, repair the candidate, refresh every invalidated exact-head check, then start a new fresh read-only review phase. A reviewer must never modify the candidate while simultaneously treating its own judgement as the final approval.\n"
)
if text.count(marker) != 1:
    raise RuntimeError("merge approval marker not found")
text = text.replace(marker, replacement, 1)
old = "- preserve human review: never silently edit `AGENTS.md` on `main`"
new = "- preserve the explicit review gate: never silently edit `AGENTS.md` on `main`"
if text.count(old) != 1:
    raise RuntimeError("human-review retrospective marker not found")
text = text.replace(old, new, 1)
agents.write_text(text)

replace_once(
    "skills/release-readiness-review/SKILL.md",
    "- Review separation: confirm the final reviewer is the read-only Technical Lead, did not author or modify the reviewed implementation, has no mutation authority, and performs a fresh review of the exact checked head. The same model or CLI may be reused; model diversity is metadata, not the independence gate. Reject Code Worker self-review.",
    "- Review separation: confirm the final Technical Lead review is a distinct read-only phase over the pinned exact checked head, with no mutation authority while judging the candidate. Reviewer identity may be the same capable agent/model that implemented earlier work only after implementation has ended and the reviewer freshly re-derives its judgement from the issue/acceptance contract and current diff. A finding that requires mutation ends the review phase; repair, exact-head revalidation, and a new fresh review are then required. Different reviewer identity is preferred when available, but identity/model/human diversity is metadata rather than the independence gate.",
)
replace_once(
    "skills/release-readiness-review/SKILL.md",
    "Lead with blocking risks. Then list non-blocking observations and final release confidence. Do not classify stale required documentation, missing exact-head evidence, absent Technical Lead role separation, or Code Worker self-review as a non-blocking follow-up.",
    "Lead with blocking risks. Then list non-blocking observations and final release confidence. Do not classify stale required documentation, missing exact-head evidence, a review that was not a distinct read-only exact-head phase, or mutation performed during the purported final review as a non-blocking follow-up.",
)

subprocess.run(["git", "config", "user.name", "github-actions[bot]"], check=True)
subprocess.run(["git", "config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"], check=True)
subprocess.run(["git", "add", "AGENTS.md", "skills/release-readiness-review/SKILL.md"], check=True)
subprocess.run(["git", "commit", "-m", "docs: define review independence by phase"], check=True)
subprocess.run(["git", "push", "origin", f"HEAD:{BRANCH}"], check=True)
