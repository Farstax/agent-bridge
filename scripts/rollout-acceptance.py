#!/usr/bin/env python3
"""Compare bounded pre/post rollout evidence without changing runtime state."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path


def fail(message: str) -> None:
    raise RuntimeError(message)


def load(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        fail(f"invalid acceptance evidence: {error}")
    if not isinstance(value, dict) or not isinstance(value.get("databases"), list):
        fail("acceptance evidence must contain a databases list")
    return value


def compare(before: dict, after: dict, reconciliation_evidence: dict | None = None) -> dict:
    left = {entry.get("path"): entry for entry in before["databases"]}
    right = {entry.get("path"): entry for entry in after["databases"]}
    if set(left) != set(right) or None in left:
        fail("database inventory changed during bounded acceptance")
    results = []
    for path in sorted(left):
        old, new = left[path], right[path]
        if old.get("integrity") != "ok" or new.get("integrity") != "ok":
            fail(f"database integrity is not ok: {path}")
        before_lifecycle = old.get("lifecycle", {})
        after_lifecycle = new.get("lifecycle", {})
        if (old.get("executionLockState", {}).get("total", 0) or new.get("executionLockState", {}).get("total", 0)) and not (before_lifecycle or after_lifecycle):
            fail(f"active execution lock lifecycle evidence is missing: {path}")
        if any(row.get("classification") == "ambiguous" for row in before_lifecycle.get("runs", []) + before_lifecycle.get("locks", [])):
            fail(f"ambiguous preflight lifecycle ownership: {path}")
        direct_database = next((entry for entry in (reconciliation_evidence or {}).get("databases", []) if entry.get("path") == path), None)
        direct_reconciliation = (direct_database or {}).get("lifecycle", {}).get("reconciliation", {})
        authorized_audits = {str(row.get("id")): row for row in direct_reconciliation.get("audits", [])}
        after_audits = {str(row.get("id")): row for row in after_lifecycle.get("reconciliation", {}).get("audits", [])}
        if direct_database is not None and set(authorized_audits) - set(after_audits):
            fail(f"current rollout reconciliation audit is missing after restart: {path}")
        reconciled_runs = {str(row.get("subject_id")) for row in authorized_audits.values() if row.get("kind") == "run"}
        if direct_database is None:
            reconciled_runs = set(after_lifecycle.get("reconciliation", {}).get("runs", []))
        lock_snapshots = direct_reconciliation.get("lockSnapshots", [])
        if direct_database is None:
            lock_snapshots = after_lifecycle.get("reconciliation", {}).get("locks", [])
        reconciled_locks = {
            (row.get("surface"), row.get("chat_key"), row.get("run_id"), row.get("acquisition_id"))
            for row in lock_snapshots
        }
        def lock_was_reconciled(key: tuple) -> bool:
            return any(
                candidate[2] == key[2] and candidate[3] == key[3]
                and (candidate[0] is None or candidate[0] == key[0])
                and (candidate[1] is None or candidate[1] == key[1])
                for candidate in reconciled_locks
            )

        old_runs = {row.get("run_id"): row for row in old.get("runIdentityCorrelation", [])}
        new_runs = {row.get("run_id"): row for row in new.get("runIdentityCorrelation", [])}
        if set(old_runs) - set(new_runs):
            fail(f"pre-existing run identity deleted: {path}")
        for run_id, old_run in old_runs.items():
            new_run = new_runs[run_id]
            if old_run.get("status") == "running" and new_run != old_run:
                if not (run_id in reconciled_runs and new_run.get("status") == "failed"):
                    fail(f"unexplained running status change: {path}: {run_id}")
                for key, value in old_run.items():
                    if key not in {"status", "ended_at", "error"} and new_run.get(key) != value:
                        fail(f"running identity changed during reconciliation: {path}: {run_id}")
            elif old_run != new_run:
                fail(f"terminal run identity changed: {path}: {run_id}")
        for run_id, new_run in new_runs.items():
            if run_id not in old_runs:
                created = new.get("restartBoundary") or old.get("createdAt")
                if created and new_run.get("started_at", "") < created:
                    fail(f"pre-existing run appeared before restart boundary: {path}: {run_id}")

        old_events = {row.get("id"): row for row in old.get("deliveryIdentityCorrelation", [])}
        new_events = {row.get("id"): row for row in new.get("deliveryIdentityCorrelation", [])}
        if set(old_events) - set(new_events):
            fail(f"pre-existing event deleted: {path}")
        for event_id, old_event in old_events.items():
            if new_events[event_id] != old_event:
                fail(f"pre-existing event changed: {path}: {event_id}")
        for event_id, event in new_events.items():
            if event_id not in old_events and event.get("run_id") in old_runs and event.get("run_id") not in reconciled_runs:
                fail(f"unexplained event appended to pre-existing run: {path}: {event_id}")
            if event_id not in old_events and event.get("run_id") not in old_runs and new.get("restartBoundary") and event.get("timestamp", "") < new["restartBoundary"]:
                fail(f"post-restart event appeared before restart boundary: {path}: {event_id}")
        for run_id in set(new_runs) - set(old_runs):
            if not any(event.get("run_id") == run_id for event in new_events.values()):
                fail(f"post-restart run has no correlated event: {path}: {run_id}")
        if any(event.get("run_id") not in new_runs for event in new_events.values()):
            fail(f"event references an unknown run: {path}")

        old_locks = {
            (row.get("surface"), row.get("chat_key"), row.get("run_id"), row.get("acquisition_id")): row
            for row in old.get("runLockCorrelation", {}).get("locks", [])
        }
        new_locks = {
            (row.get("surface"), row.get("chat_key"), row.get("run_id"), row.get("acquisition_id")): row
            for row in new.get("runLockCorrelation", {}).get("locks", [])
        }
        for key in old_locks.keys() - new_locks.keys():
            if not lock_was_reconciled(key):
                fail(f"unexplained execution lock removal: {path}: {key}")
        for key in new_locks.keys() - old_locks.keys():
            if key[2] in old_runs and key[2] not in reconciled_runs:
                fail(f"unexplained execution lock ownership change: {path}: {key}")
        for key in ("runIdentityCorrelation", "deliveryIdentityCorrelation"):
            if not isinstance(old.get(key), list) or not isinstance(new.get(key), list):
                fail(f"missing durable identity evidence: {path}: {key}")
        if new.get("schema") != "current":
            fail(f"database schema is not current: {path}")
        if old.get("schema") != "current":
            if old.get("pendingQueueCount") != new.get("pendingQueueCount"):
                fail(f"queue count changed across schema migration for {path}")
            results.append({"path": path, "status": "unchanged-across-schema-migration", "queueClaimLockCorrelation": "queue-count-and-post-migration-lock-verified"})
            continue
        for key in ("pendingQueueCount", "legacyQueueCount", "queueStateCounts", "claimStateCounts"):
            if old.get(key) != new.get(key):
                fail(f"queue/claim/run/lock/delivery correlation changed for {path}: {key}")
        if old.get("runLockCorrelation", {}).get("queue") != new.get("runLockCorrelation", {}).get("queue"):
            fail(f"queue/claim/run/lock/delivery correlation changed for {path}: runLockCorrelation")
        results.append({"path": path, "status": "unchanged", "queueClaimLockCorrelation": "verified"})
    return {
        "accepted": True,
        "createdAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "databaseCount": len(results),
        "databases": results,
        "duplicateDelivery": "no-change-bounded-acceptance",
        "restartContinuation": "queue-claim-lock identity preserved",
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--before", type=Path, required=True)
    parser.add_argument("--after", type=Path, required=True)
    parser.add_argument("--reconciliation-evidence", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = compare(load(args.before), load(args.after), load(args.reconciliation_evidence) if args.reconciliation_evidence else None)
    args.output.write_text(json.dumps(result, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    args.output.chmod(0o600)
    print("accepted")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"rollout-acceptance: {error}", file=__import__("sys").stderr)
        raise SystemExit(1)
