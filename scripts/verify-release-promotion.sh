#!/usr/bin/env bash
set -Eeuo pipefail

die() {
  echo "release promotion verification failed: $*" >&2
  exit 1
}

artifact_dir=""
commit=""
workflow_run=""
while (($# > 0)); do
  case "$1" in
    --artifact-dir) artifact_dir="${2:-}"; shift 2 ;;
    --commit) commit="${2:-}"; shift 2 ;;
    --workflow-run) workflow_run="${2:-}"; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ -d "$artifact_dir" ]] || die "artifact directory does not exist"
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || die "commit must be a full lowercase 40-character Git SHA"
[[ "$workflow_run" =~ ^[1-9][0-9]*$ ]] || die "workflow run must be a positive numeric ID"

archive_name="agent-bridge-${commit}.tar.gz"
checksum_name="${archive_name}.sha256"
archive_path="${artifact_dir}/${archive_name}"
checksum_path="${artifact_dir}/${checksum_name}"

mapfile -t entries < <(find "$artifact_dir" -mindepth 1 -maxdepth 1 -printf '%f\n' | LC_ALL=C sort)
[[ "${#entries[@]}" == "2" ]] || die "artifact directory must contain exactly the archive and checksum"
[[ "${entries[0]}" == "$archive_name" && "${entries[1]}" == "$checksum_name" ]] \
  || die "artifact directory contains unexpected files"
[[ -f "$archive_path" && ! -L "$archive_path" && -f "$checksum_path" && ! -L "$checksum_path" ]] \
  || die "release artifact files must be regular files"

checksum_line="$(cat "$checksum_path")"
[[ "$checksum_line" =~ ^([0-9a-f]{64})\ \ ${archive_name}$ ]] \
  || die "checksum file must contain the exact archive name and SHA-256"
archive_sha256="${BASH_REMATCH[1]}"
(
  cd "$artifact_dir"
  sha256sum -c "$checksum_name" >/dev/null
) || die "archive checksum does not match"

mapfile -t archive_entries < <(tar -tzf "$archive_path") || die "release archive is unreadable"
manifest_count=0
evidence_count=0
for raw_entry in "${archive_entries[@]}"; do
  entry="${raw_entry#./}"
  [[ -z "$entry" ]] && continue
  [[ "$entry" != /* && "$entry" != ".." && "$entry" != ../* && "$entry" != */../* && "$entry" != */.. ]] \
    || die "archive contains an unsafe member path"
  [[ "$entry" == "manifest.json" ]] && ((manifest_count += 1))
  [[ "$entry" == "qualification-evidence.json" ]] && ((evidence_count += 1))
done
[[ "$manifest_count" == "1" ]] || die "archive must contain exactly one manifest.json"
[[ "$evidence_count" == "1" ]] || die "archive must contain exactly one qualification-evidence.json"

manifest="$(tar -xOzf "$archive_path" ./manifest.json)" || die "manifest.json is unreadable"
evidence="$(tar -xOzf "$archive_path" ./qualification-evidence.json)" \
  || die "qualification-evidence.json is unreadable"

manifest_schema="$(jq -er '.schema_version' <<<"$manifest")" || die "manifest is invalid JSON"
manifest_commit="$(jq -er '.commit' <<<"$manifest")" || die "manifest commit is missing"
manifest_tree="$(jq -er '.tree' <<<"$manifest")" || die "manifest tree is missing"
builder_commit="$(jq -er '.builder.commit' <<<"$manifest")" || die "manifest builder commit is missing"
builder_head="$(jq -er '.builder.workflow_head' <<<"$manifest")" || die "manifest builder workflow head is missing"
builder_run="$(jq -er '.builder.workflow_run | tostring' <<<"$manifest")" \
  || die "manifest builder workflow run is missing"
runtime_platform="$(jq -er '.runtime.platform' <<<"$manifest")" || die "manifest runtime platform is missing"
runtime_arch="$(jq -er '.runtime.arch' <<<"$manifest")" || die "manifest runtime architecture is missing"

[[ "$manifest_schema" == "1" ]] || die "manifest schema version is unsupported"
[[ "$manifest_commit" == "$commit" ]] || die "manifest commit does not match"
[[ "$manifest_tree" =~ ^[0-9a-f]{40}$ ]] || die "manifest tree is invalid"
[[ "$builder_commit" == "$commit" && "$builder_head" == "$commit" ]] \
  || die "manifest builder commit does not match"
[[ "$builder_run" == "$workflow_run" ]] || die "manifest builder workflow run does not match"
[[ "$runtime_platform" == "linux" && "$runtime_arch" == "x64" ]] \
  || die "manifest runtime must be linux/x64"

evidence_commit="$(jq -er '.commit' <<<"$evidence")" || die "qualification evidence commit is missing"
evidence_tree="$(jq -er '.tree' <<<"$evidence")" || die "qualification evidence tree is missing"
evidence_head="$(jq -er '.workflow_head' <<<"$evidence")" || die "qualification workflow head is missing"
evidence_run="$(jq -er '.workflow_run | tostring' <<<"$evidence")" || die "qualification workflow run is missing"
[[ "$evidence_commit" == "$commit" && "$evidence_head" == "$commit" ]] \
  || die "qualification evidence commit does not match"
[[ "$evidence_tree" == "$manifest_tree" ]] || die "qualification evidence tree does not match manifest"
[[ "$evidence_run" == "$workflow_run" ]] || die "qualification workflow run does not match"

for required_check in test typecheck architecture-lint compile manifest; do
  jq -e --arg check "$required_check" '.checks | type == "array" and index($check) != null' \
    <<<"$evidence" >/dev/null || die "qualification evidence is missing required check: $required_check"
done

jq -cn \
  --arg archive "$archive_name" \
  --arg archive_sha256 "$archive_sha256" \
  --arg commit "$commit" \
  --arg tree "$manifest_tree" \
  --arg workflow_run "$workflow_run" \
  '{archive:$archive,archive_sha256:$archive_sha256,commit:$commit,tree:$tree,workflow_run:$workflow_run}'
