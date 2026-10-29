#!/usr/bin/env bash
# Remove files from an assembled release tree that no shipped entrypoint reads
# at runtime (#1100). Run by the release workflow before the manifest is
# generated, so the manifest and archive describe exactly the pruned tree.
#
# - TypeScript declarations and source maps: the runtime executes compiled
#   JavaScript or type-stripped source through tsx; neither reads them.
# - Grok's brotli fallback payload: the package postinstall already wrote the
#   native binary that bin/grok links to. The payload is only a fallback for
#   a missing binary, so it is removed only after that binary is verified.
set -Eeuo pipefail

root="${1:?usage: prune-release-tree.sh <release-root>}"
[[ -d "$root/node_modules" && ! -L "$root" ]] || { echo "prune-release-tree: invalid release root: $root" >&2; exit 1; }

for tree in "$root/node_modules" "$root/dist"; do
  [[ -d "$tree" ]] || continue
  find "$tree" -type f \( -name '*.map' -o -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' \) -delete
done

grok_dir="$root/node_modules/@xai-official/grok/bin"
grok_payload="$root/node_modules/@xai-official/grok-linux-x64/bin/grok.br"
if [[ -f "$grok_payload" ]]; then
  if [[ -L "$grok_dir/grok" && "$(readlink "$grok_dir/grok")" == "./grok-native" \
        && -f "$grok_dir/grok-native" && ! -L "$grok_dir/grok-native" && -x "$grok_dir/grok-native" ]]; then
    rm -f "$grok_payload"
  else
    echo "prune-release-tree: keeping Grok payload; native binary is not installed" >&2
  fi
fi
