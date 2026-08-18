#!/usr/bin/env python3
from pathlib import Path
import subprocess

BRANCH = "agent/issue-484-review-repair-flow"


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    if text.count(old) != 1:
        raise RuntimeError(f"expected exactly one target in {path}, found {text.count(old)}")
    p.write_text(text.replace(old, new, 1))


replace_once(
    "AGENTS.md",
    "If that review finds a change is required, the review phase ends before mutation. Resume implementation, repair the candidate, refresh every invalidated exact-head check, then start a new fresh read-only review phase. A reviewer must never modify the candidate while simultaneously treating its own judgement as the final approval.",
    "If that review finds a change is required, record the finding against the reviewed exact head and end the review phase before mutation. Ending review is an internal phase transition, not a reason to stop delivery. When the defect is clear, bounded, inside the already-authorised scope, and the smallest safe repair is evident, immediately resume implementation, make that repair, run the focused validation, refresh every invalidated exact-head check, then start a new fresh read-only review phase — do not turn the finding into a conversational blocker or ask for routine approval already granted by the delivery directive. Pause for owner input only when the finding changes product intent, materially expands scope, presents materially different repair choices that require an owner decision, requires a separately protected irreversible/costly action, or cannot be safely resolved from the existing contract. A reviewer must never modify the candidate while simultaneously treating its own judgement as the final approval.",
)

replace_once(
    "skills/release-readiness-review/SKILL.md",
    "- Review separation: confirm the final Technical Lead review is a distinct read-only phase over the pinned exact checked head, with no mutation authority while judging the candidate. Reviewer identity may be the same capable agent/model that implemented earlier work only after implementation has ended and the reviewer freshly re-derives its judgement from the issue/acceptance contract and current diff. A finding that requires mutation ends the review phase; repair, exact-head revalidation, and a new fresh review are then required. Different reviewer identity is preferred when available, but identity/model/human diversity is metadata rather than the independence gate.",
    "- Review separation: confirm the final Technical Lead review is a distinct read-only phase over the pinned exact checked head, with no mutation authority while judging the candidate. Reviewer identity may be the same capable agent/model that implemented earlier work only after implementation has ended and the reviewer freshly re-derives its judgement from the issue/acceptance contract and current diff. A finding that requires mutation must be recorded against that exact head and ends the review phase. If the defect and smallest safe repair are clear, bounded, in scope, and already authorised, immediately resume implementation and repair it without conversationally blocking delivery; then refresh invalidated exact-head checks and start a new fresh review. Pause only for a genuinely new owner decision, material scope change, materially different repair choices, separately protected irreversible/costly action, or unresolved ambiguity. Different reviewer identity is preferred when available, but identity/model/human diversity is metadata rather than the independence gate.",
)

subprocess.run(["git", "config", "user.name", "github-actions[bot]"], check=True)
subprocess.run(["git", "config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"], check=True)
subprocess.run(["git", "add", "AGENTS.md", "skills/release-readiness-review/SKILL.md"], check=True)
subprocess.run(["git", "commit", "-m", "docs: repair clear review findings without blocking"], check=True)
subprocess.run(["git", "push", "origin", f"HEAD:{BRANCH}"], check=True)
