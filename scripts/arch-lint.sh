#!/usr/bin/env bash
# Architecture lint guard (Epic 11, issue #52).
# Fails when production code under src/ imports or calls test-only APIs.
# General raw SQLite boundary enforcement is intentionally deferred (see
# issue #52); the advisor_calls/advisor_attempts and
# conversation_turns/conversation_summaries tables are a narrow, Phase 4B
# exception (see issue #135) — their SQL is confined to the repository files
# that own them, plus the legacy baseline migration that creates them and one
# explicitly marked non-schema maintenance statement in src/db.ts.
set -euo pipefail

TARGET_DIR="${1:-src}"

if [ ! -d "$TARGET_DIR" ]; then
  echo "arch-lint: directory not found: $TARGET_DIR" >&2
  exit 2
fi

violations=$(grep -rnE \
  -e 'from "vitest"' \
  -e "from 'vitest'" \
  -e 'from "node:test"' \
  -e "from 'node:test'" \
  -e 'require\(["'"'"']vitest["'"'"']\)' \
  -e 'require\(["'"'"']node:test["'"'"']\)' \
  -e '^\s*(describe|it|test)\(' \
  --include='*.ts' --include='*.js' --include='*.mjs' --include='*.cjs' \
  "$TARGET_DIR" || true)

if [ -n "$violations" ]; then
  echo "arch-lint: test-only APIs must not be imported or called from src/" >&2
  echo "$violations" >&2
  exit 1
fi

# Current execution-topology ownership. These are live architecture rules, not
# historical tombstones: conversation recording belongs to the engine, context
# preamble injection belongs to the engine, and the removed Engineering Worker
# must not reappear as a second execution path.
topology_violations=""
check_topology_file() {
  local path="$1"
  local pattern="$2"
  [ -f "$path" ] || return 0
  local matches
  matches=$(grep -nE "$pattern" "$path" || true)
  if [ -n "$matches" ]; then
    topology_violations+="${path}:${matches}"$'\n'
  fi
}

check_topology_file "$TARGET_DIR/index-interactive.ts" 'fallbackChain\.addTurn|buildContextPreamble|contextPreambles'
check_topology_file "$TARGET_DIR/index-discord-interactive.ts" 'fallbackChain\.addTurn|buildContextPreamble|contextPreambles'
check_topology_file "$TARGET_DIR/interactiveBot.ts" 'buildContextPreamble|contextPreambles'
check_topology_file "$TARGET_DIR/providerFallback.ts" 'buildContextPreamble|contextPreambles'
check_topology_file "$TARGET_DIR/engine.ts" 'mode: \"async\" \| \"sync\"|async executePrompt\('

if [ -n "$topology_violations" ]; then
  echo "arch-lint: execution topology ownership must remain with the engine" >&2
  printf '%s' "$topology_violations" >&2
  exit 1
fi

if [ -e "$TARGET_DIR/index-worker.ts" ]; then
  echo "arch-lint: Engineering Worker execution path must not be reintroduced" >&2
  echo "$TARGET_DIR/index-worker.ts" >&2
  exit 1
fi

worker_violations=$(grep -rnE \
  -e 'WORKER_CLI_CHAIN' \
  -e 'WorkerFallbackChain' \
  -e 'claimNextWorkJob' \
  -e 'createWorkJob' \
  -e 'recoverExpiredWorkJobs' \
  --include='*.ts' --include='*.js' --include='*.mjs' --include='*.cjs' \
  "$TARGET_DIR" || true)

if [ -n "$worker_violations" ]; then
  echo "arch-lint: Engineering Worker execution path must not be reintroduced" >&2
  echo "$worker_violations" >&2
  exit 1
fi

# Advisor/conversation SQL ownership guard (Phase 4B, issue #135): the
# advisor_calls/advisor_attempts/conversation_turns/conversation_summaries
# tables must only be referenced from their owning repository, the legacy
# baseline migration (which creates them), or a statement whose immediately
# preceding comment block carries an explicit `arch-lint-allow-legacy-sql`
# marker. Delegated to a Node script (scripts/sqlOwnershipLint.mjs) because
# binding a marker to exactly one statement — not a fixed line window that
# could let a nearby unmarked statement slip through — needs real per-line
# state, not a single grep pass.
if ! node "$(dirname "$0")/sqlOwnershipLint.mjs" "$TARGET_DIR"; then
  exit 1
fi

# Migration-primitive ownership guard (Phase 4C.2, issue #135): deny-by-default
# for openDb/applyMigrations/applyMigrationsUpTo/applyLegacyCompatibleBaseline
# outside their three defining files. See scripts/migrationOwnershipLint.mjs.
if ! node "$(dirname "$0")/migrationOwnershipLint.mjs" "$TARGET_DIR"; then
  exit 1
fi

echo "arch-lint: ok ($TARGET_DIR)"
