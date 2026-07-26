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


def compare(before: dict, after: dict) -> dict:
    left = {entry.get("path"): entry for entry in before["databases"]}
    right = {entry.get("path"): entry for entry in after["databases"]}
    if set(left) != set(right) or None in left:
        fail("database inventory changed during bounded acceptance")
    results = []
    for path in sorted(left):
        old, new = left[path], right[path]
        if old.get("integrity") != "ok" or new.get("integrity") != "ok":
            fail(f"database integrity is not ok: {path}")
        if new.get("schema") != "current":
            fail(f"database schema is not current: {path}")
        if new.get("executionLockState", {}).get("active", 0) or new.get("executionLockState", {}).get("total", 0):
            fail(f"active execution lock requires an explicit continuation contract: {path}")
        if old.get("executionLockState", {}).get("active", 0) or old.get("executionLockState", {}).get("total", 0):
            fail(f"pre-existing execution lock is ambiguous: {path}")
        if old.get("schema") != "current":
            if old.get("pendingQueueCount") != new.get("pendingQueueCount"):
                fail(f"queue count changed across schema migration for {path}")
            results.append({"path": path, "status": "unchanged-across-schema-migration", "queueClaimLockCorrelation": "queue-count-and-post-migration-lock-verified"})
            continue
        for key in ("pendingQueueCount", "legacyQueueCount", "queueStateCounts", "claimStateCounts", "claimRunAcquisitionCorrelation", "runLockCorrelation", "deliveryState"):
            if old.get(key) != new.get(key):
                fail(f"queue/claim/run/lock/delivery correlation changed for {path}: {key}")
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
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = compare(load(args.before), load(args.after))
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
