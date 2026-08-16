#!/usr/bin/env bash
# Generates GitHub release notes for a qualified Agent Bridge runtime artifact.
# Run inside a checkout that has the previous release tag reachable from the
# release commit (the publish workflow fetches full history for this).
set -Eeuo pipefail

commit=""
workflow_run=""
checksum=""
previous_tag=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --commit) commit="$2"; shift 2 ;;
    --workflow-run) workflow_run="$2"; shift 2 ;;
    --checksum) checksum="$2"; shift 2 ;;
    --previous-tag) previous_tag="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$commit" ]] || { echo "--commit is required" >&2; exit 2; }
[[ -n "$workflow_run" ]] || { echo "--workflow-run is required" >&2; exit 2; }
[[ -n "$checksum" ]] || { echo "--checksum is required" >&2; exit 2; }

cat <<EOF
Qualified Agent Bridge runtime artifact.

- Commit: \`${commit}\`
- Source workflow run: \`${workflow_run}\`
- Archive SHA-256: \`${checksum}\`

Publication does not deploy this release.

---

EOF

if [[ -z "$previous_tag" ]]; then
  echo "Initial qualified release. No previous release tag to diff against."
  exit 0
fi

echo "### Changes since \`${previous_tag}\`"
echo

# PRs land on main in two shapes: an ordinary merge commit (2+ parents, subject
# "Merge pull request #NNN from ..."), or a GitHub squash merge (1 parent,
# subject ending "(#NNN)"). --first-parent walks only main's own lineage, so it
# visits exactly one entry per PR landing point and skips the individual
# commits folded into a merge's second parent — those can carry their own
# "(#NNN)" issue references and would otherwise be misread as separate PRs.
changes="$(git log --first-parent --format='%H|%s' "${previous_tag}..${commit}" 2>/dev/null || true)"

if [[ -z "$changes" ]]; then
  echo "No merged pull requests since \`${previous_tag}\`."
  exit 0
fi

found=0
while IFS='|' read -r sha subject; do
  [[ -n "$sha" ]] || continue
  pr_number=""
  title=""
  if [[ "$subject" =~ ^Merge\ pull\ request\ \#([0-9]+)\  ]]; then
    pr_number="${BASH_REMATCH[1]}"
    title="$(git log -1 --format='%b' "$sha" | sed '/^$/d' | head -n1)"
  elif [[ "$subject" =~ ^(.*)\ \(\#([0-9]+)\)$ ]]; then
    title="${BASH_REMATCH[1]}"
    pr_number="${BASH_REMATCH[2]}"
  else
    continue
  fi
  found=1
  short_sha="${sha:0:8}"
  if [[ -n "$title" ]]; then
    echo "- #${pr_number} — ${title} (\`${short_sha}\`)"
  else
    echo "- #${pr_number} (\`${short_sha}\`)"
  fi
done <<< "$changes"

if [[ "$found" == "0" ]]; then
  echo "No merged pull requests since \`${previous_tag}\`."
fi
