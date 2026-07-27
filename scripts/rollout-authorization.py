#!/usr/bin/env python3
"""Validate and materialize one explicit, target-bound rollout approval."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path

SHA = re.compile(r"^[0-9a-f]{40}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
TOKEN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$")

IDENTITY_FIELDS = {
    "approved_artifact_sha256": "artifact_sha256",
    "approved_evidence_sha256": "evidence_sha256",
    "approved_environment": "environment",
    "approved_rollout_helper_sha256": "rollout_helper_sha256",
    "approved_rollout_config_sha256": "rollout_config_sha256",
    "approved_authorization_validator_sha256": "authorization_validator_sha256",
    "approved_acceptance_validator_sha256": "acceptance_validator_sha256",
}


def fail(message: str) -> None:
    raise RuntimeError(message)


def timestamp(value: object, field: str) -> datetime:
    if not isinstance(value, str) or not value.endswith("Z"):
        fail(f"authorization {field} must be an ISO-8601 UTC timestamp")
    try:
        parsed = datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError as error:
        fail(f"authorization {field} is invalid: {error}")
    if parsed.tzinfo != timezone.utc:
        fail(f"authorization {field} must use UTC")
    return parsed


def validate(path: Path, expected_commit: str, expected_identities: dict[str, str], now: datetime, production: bool) -> dict:
    if not SHA.fullmatch(expected_commit):
        fail("expected commit must be a full lowercase 40-character SHA")
    if path.is_symlink() or not path.is_file():
        fail("authorization file must be a regular non-symlink file")
    if path.resolve() != path:
        fail("authorization file must be canonical")
    metadata = path.stat()
    if metadata.st_mode & 0o077:
        fail("authorization file must not be group/world accessible")
    if production and metadata.st_uid != 0:
        fail("production authorization file must be owned by root")
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        fail(f"invalid rollout authorization: {error}")
    if not isinstance(document, dict):
        fail("rollout authorization must be a JSON object")
    required_fields = ("principal", "reference", "approved_target_commit", "approved_at", "expires_at", "scope", *IDENTITY_FIELDS)
    for field in required_fields:
        value = document.get(field)
        if not isinstance(value, str) or not value:
            fail(f"authorization {field} is required")
    for field in ("principal", "reference", "scope"):
        if not TOKEN.fullmatch(document[field]):
            fail(f"authorization {field} contains unsupported characters")
    if not SHA.fullmatch(document["approved_target_commit"]):
        fail("authorization approved_target_commit must be a full lowercase SHA")
    if document["approved_target_commit"] != expected_commit:
        fail("authorization target commit does not match expected commit")
    for document_field, expected_key in IDENTITY_FIELDS.items():
        value = document[document_field]
        pattern = TOKEN if document_field == "approved_environment" else SHA256
        if not pattern.fullmatch(value):
            fail(f"authorization {document_field} has an invalid identity")
        expected = expected_identities[expected_key]
        if value != expected:
            fail(f"authorization {document_field} does not match expected {expected_key}")
    approved_at = timestamp(document["approved_at"], "approved_at")
    expires_at = timestamp(document["expires_at"], "expires_at")
    if expires_at <= approved_at:
        fail("authorization expires_at must be after approved_at")
    if approved_at > now:
        fail("authorization approved_at is in the future")
    if expires_at <= now:
        fail("authorization is expired")
    result = {
        "principal": document["principal"],
        "reference": document["reference"],
        "approved_target_commit": document["approved_target_commit"],
        "approved_at": document["approved_at"],
        "expires_at": document["expires_at"],
        "scope": document["scope"],
        **{field: document[field] for field in IDENTITY_FIELDS},
        "authorization_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
    }
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--file", type=Path, required=True)
    parser.add_argument("--expected-commit", required=True)
    parser.add_argument("--expected-artifact-sha256", required=True)
    parser.add_argument("--expected-evidence-sha256", required=True)
    parser.add_argument("--expected-environment", required=True)
    parser.add_argument("--expected-rollout-helper-sha256", required=True)
    parser.add_argument("--expected-rollout-config-sha256", required=True)
    parser.add_argument("--expected-authorization-validator-sha256", required=True)
    parser.add_argument("--expected-acceptance-validator-sha256", required=True)
    parser.add_argument("--now")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    now = timestamp(args.now, "now") if args.now else datetime.now(timezone.utc)
    result = validate(args.file, args.expected_commit, {
        "artifact_sha256": args.expected_artifact_sha256,
        "evidence_sha256": args.expected_evidence_sha256,
        "environment": args.expected_environment,
        "rollout_helper_sha256": args.expected_rollout_helper_sha256,
        "rollout_config_sha256": args.expected_rollout_config_sha256,
        "authorization_validator_sha256": args.expected_authorization_validator_sha256,
        "acceptance_validator_sha256": args.expected_acceptance_validator_sha256,
    }, now, os.geteuid() == 0)
    content = json.dumps(result, sort_keys=True, indent=2) + "\n"
    if args.output:
        args.output.write_text(content, encoding="utf-8")
        os.chmod(args.output, 0o600)
    else:
        print(content, end="")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        import sys
        print(f"rollout-authorization: {error}", file=sys.stderr)
        raise SystemExit(1)
