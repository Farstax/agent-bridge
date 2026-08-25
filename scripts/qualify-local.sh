#!/usr/bin/env bash
# Authoritative pre-merge gate. This is the single source of truth for the
# deterministic checks that must pass before merging: GitHub Actions CI
# (.github/workflows/ci.yml) runs this exact script so local and hosted CI
# cannot silently drift apart.
#
# Network/credential/host-service-dependent checks (e.g. provider
# qualification, live-provider smoke tests) are intentionally out of scope —
# see AGENTS.md "Provider qualification and CLI drift". Those fail/skip
# explicitly on their own opt-in triggers and do not gate this pack.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "==> npm test"
npm test

echo "==> npm run typecheck"
npm run typecheck

echo "==> architecture lint"
bash scripts/arch-lint.sh src

echo "qualify:local: ok"
