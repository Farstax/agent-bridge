#!/usr/bin/env bash
set -euo pipefail

fail() { echo "install-agy-acp: $*" >&2; exit 1; }
print_required_bytes=0
[[ "${1:-}" != "--print-required-bytes" ]] || print_required_bytes=1
phase="${AGENT_BRIDGE_HOST_COMPONENT_PHASE:-converge}"
[[ "$phase" == prepare || "$phase" == commit || "$phase" == converge || "$phase" == verify ]] || fail "invalid phase"
if (( print_required_bytes == 0 )) && [[ "$phase" != verify ]]; then
  [[ "$(id -u)" == 0 ]] || fail "must run as root"
fi
[[ "$(uname -s)" == Linux ]] || fail "Agy CLI is supported only on Linux"
case "$(uname -m)" in
  x86_64|amd64) registry_platform=linux-x86_64 ;;
  aarch64|arm64) registry_platform=linux-aarch64 ;;
  *) fail "unsupported architecture" ;;
esac
for cmd in curl python3 sha256sum readlink stat; do command -v "$cmd" >/dev/null || fail "missing $cmd"; done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RELEASE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REGISTRY_DATA="$RELEASE_DIR/dist/providers/acpRegistry.locked.json"
[[ -f "$REGISTRY_DATA" && ! -L "$REGISTRY_DATA" ]] || fail "release-locked ACP registry unavailable"
registry_row="$(python3 - "$REGISTRY_DATA" "$registry_platform" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as f:
    document = json.load(f)
entry = document.get("providers", {}).get("agy")
binary = (entry or {}).get("distribution", {}).get("binary", {}).get(sys.argv[2])
if document.get("schema_version") != 1 or not entry or not binary: raise SystemExit(2)
print("\t".join((entry["version"], binary["archive"], binary["cmd"], binary.get("sha256") or "-")))
PY
)" || fail "missing release-locked Agy CLI metadata for $registry_platform"
IFS=$'\t' read -r VERSION ARCHIVE_URL REGISTRY_CMD ARCHIVE_SHA <<<"$registry_row"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "invalid version"
[[ "$REGISTRY_CMD" == "./agy" ]] || fail "expected official CLI executable"
[[ "$ARCHIVE_URL" == "https://github.com/google-antigravity/antigravity-cli/releases/download/$VERSION/"*".tar.gz" ]] || fail "expected exact-version official release asset"
[[ "$ARCHIVE_SHA" =~ ^[0-9a-f]{64}$ ]] || fail "release lock requires SHA-256"

ROOT="${AGENT_BRIDGE_AGY_ACP_ROOT:-/opt/agent-bridge/host-components/agy-acp}"
LINK="${AGENT_BRIDGE_AGY_ACP_LINK:-/usr/local/bin/agy}"
VERSION_DIR="$ROOT/components/$VERSION"
COMPONENT_DIR="$VERSION_DIR/$registry_platform"
BINARY="$COMPONENT_DIR/agy"
MANIFEST="$COMPONENT_DIR/manifest.json"
CHANGED=0
[[ "$ROOT" == /* && "$LINK" == /* && ! -L "$ROOT" ]] || fail "unsafe managed paths"
normalize_runtime_dir() {
  local path="$1"
  [[ -d "$path" && ! -L "$path" ]] || fail "managed component directory invalid"
  if [[ "$(stat -c '%u:%g:%a' "$path")" != "0:0:755" ]]; then
    chown root:root "$path"; chmod 0755 "$path"; CHANGED=1
  fi
}
valid_component() {
  [[ -d "$VERSION_DIR" && ! -L "$VERSION_DIR" && -d "$COMPONENT_DIR" && ! -L "$COMPONENT_DIR" \
    && -x "$BINARY" && ! -L "$BINARY" && -f "$MANIFEST" && ! -L "$MANIFEST" ]] || return 1
  [[ "$(stat -c '%u:%g:%a' "$VERSION_DIR")" == "0:0:755" ]] || return 1
  [[ "$(stat -c '%u:%g:%a' "$COMPONENT_DIR")" == "0:0:755" ]] || return 1
  python3 - "$MANIFEST" "$BINARY" "$VERSION" "$ARCHIVE_URL" "$registry_platform" "$ARCHIVE_SHA" <<'PY'
import hashlib, json, pathlib, stat, sys
manifest_path, binary = map(pathlib.Path, sys.argv[1:3])
version, url, platform, archive_sha = sys.argv[3:7]
def sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()
try:
    mstat, bstat = manifest_path.lstat(), binary.lstat()
    if not stat.S_ISREG(mstat.st_mode) or not stat.S_ISREG(bstat.st_mode): raise ValueError("not regular")
    if mstat.st_uid != 0 or bstat.st_uid != 0 or mstat.st_mode & 0o022 or bstat.st_mode & 0o022:
        raise ValueError("unsafe ownership or permissions")
    if not bstat.st_mode & 0o111: raise ValueError("not executable")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    expected = {"schemaVersion": 3, "version": version, "archiveUrl": url,
                "platform": platform, "binaryName": "agy", "archiveSha256": archive_sha}
    if any(manifest.get(k) != v for k,v in expected.items()): raise ValueError("identity")
    if manifest.get("binarySha256") != sha256_file(binary): raise ValueError("binary checksum")
except Exception: raise SystemExit(1)
PY
}
if [[ "$phase" == verify ]]; then
  valid_component || fail "component identity/checksum invalid"
  [[ -x "$LINK" && "$(readlink -f "$LINK")" == "$BINARY" ]] || fail "managed link does not select verified CLI"
  printf 'host_component_health=healthy\n'
  exit 0
fi
if (( print_required_bytes == 0 )); then
  mkdir -p "$ROOT/components"
  chown root:root "$ROOT" "$ROOT/components"
  chmod 0755 "$ROOT" "$ROOT/components"
  if [[ ! -e "$VERSION_DIR" ]]; then mkdir -p "$VERSION_DIR"; CHANGED=1; fi
  normalize_runtime_dir "$VERSION_DIR"
  if [[ -e "$COMPONENT_DIR" ]]; then normalize_runtime_dir "$COMPONENT_DIR"; fi
fi

if ! valid_component; then
  [[ "$phase" != commit ]] || fail "prepared Agy CLI payload missing or invalid"
  # Retain only the last Content-Length after following the immutable asset redirect.
  remote_length="$(curl --fail --location --silent --show-error --head "$ARCHIVE_URL" \
    | tr -d '\r' | awk 'tolower($1) == "content-length:" {size=$2} END {print size}')" \
    || fail "unable to determine Agy CLI archive size"
  [[ "$remote_length" =~ ^[0-9]+$ ]] || fail "Agy CLI archive did not report numeric Content-Length"
  safety_factor="${AGENT_BRIDGE_AGY_ACP_DISK_SAFETY_FACTOR:-5}"
  [[ "$safety_factor" =~ ^[1-9][0-9]*$ ]] || fail "invalid disk safety factor"
  required_bytes=$((remote_length * safety_factor))
  if (( print_required_bytes == 1 )); then printf '%s\n' "$required_bytes"; exit 0; fi
  available_bytes="$(df --output=avail -B1 "$ROOT" | tail -1 | tr -d '[:space:]')"
  [[ "$available_bytes" =~ ^[0-9]+$ ]] || fail "unable to determine available disk space"
  (( available_bytes >= required_bytes )) || fail "insufficient disk space to stage Agy CLI component: need ~$required_bytes bytes, have $available_bytes"
  work="$(mktemp -d "$ROOT/.install-$VERSION.XXXXXX")"
  trap 'rm -rf -- "${work:-}"' EXIT
  archive="$work/agy-cli.tar.gz"
  staging="$work/component"
  mkdir -p "$staging"
  curl --fail --location --silent --show-error --retry 3 --output "$archive" "$ARCHIVE_URL"
  downloaded_archive_sha="$(sha256sum "$archive" | awk '{print $1}')"
  [[ "$downloaded_archive_sha" == "$ARCHIVE_SHA" ]] || fail "release-locked Agy CLI archive checksum mismatch"
  python3 - "$archive" "$staging/agy" <<'PY'
import pathlib, shutil, sys, tarfile
archive, destination = map(pathlib.Path, sys.argv[1:3])
with tarfile.open(archive, "r:gz") as bundle:
    # The official 1.5.2 archive ships the executable as `antigravity`; it is installed as `agy`.
    matches = [m for m in bundle.getmembers() if m.isfile() and pathlib.PurePosixPath(m.name).name in ("antigravity", "agy")]
    if len(matches) != 1: raise SystemExit("expected one official agy executable")
    source = bundle.extractfile(matches[0])
    if source is None: raise SystemExit("binary unreadable")
    with source, destination.open("xb") as output:
        shutil.copyfileobj(source, output, length=1024 * 1024)
PY
  chmod 0555 "$staging/agy"; chown root:root "$staging/agy"
  binary_sha="$(sha256sum "$staging/agy" | awk '{print $1}')"
  python3 - "$staging/manifest.json" "$VERSION" "$ARCHIVE_URL" "$registry_platform" "$binary_sha" "$ARCHIVE_SHA" <<'PY'
import json, pathlib, sys
path = pathlib.Path(sys.argv[1])
path.write_text(json.dumps({
    "schemaVersion": 3, "version": sys.argv[2], "archiveUrl": sys.argv[3],
    "platform": sys.argv[4], "binaryName": "agy", "binarySha256": sys.argv[5],
    "archiveSha256": sys.argv[6],
}, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
PY
  chmod 0444 "$staging/manifest.json"; chown root:root "$staging/manifest.json"
  rm -rf -- "$COMPONENT_DIR.new"
  mv "$staging" "$COMPONENT_DIR.new"
  rm -rf -- "$COMPONENT_DIR"
  mv "$COMPONENT_DIR.new" "$COMPONENT_DIR"
  normalize_runtime_dir "$COMPONENT_DIR"
  CHANGED=1
fi
if (( print_required_bytes == 1 )); then
  valid_component || fail "unable to measure installed Agy CLI"
  printf '0\n'
  exit 0
fi
valid_component || fail "Agy CLI component identity/checksum invalid"
if [[ "$phase" == prepare ]]; then echo host_component_status=converged; exit 0; fi
mkdir -p "$(dirname "$LINK")"
if [[ "$(readlink -f "$LINK" 2>/dev/null || true)" != "$BINARY" ]]; then
  ln -sfn "$BINARY" "$LINK.new"
  mv -Tf "$LINK.new" "$LINK"
  CHANGED=1
fi
[[ -x "$LINK" && "$(readlink -f "$LINK")" == "$BINARY" ]] || fail "managed CLI link incorrect"
if (( CHANGED )); then echo host_component_status=converged; else echo host_component_status=no_op; fi
