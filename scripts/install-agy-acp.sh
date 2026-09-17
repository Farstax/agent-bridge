#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "install-agy-acp: $*" >&2
  exit 1
}

[[ "$(id -u)" == "0" ]] || fail "must run as root"
[[ "$(uname -s)" == "Linux" ]] || fail "Agy ACP managed host component is supported only on Linux"

case "$(uname -m)" in
  x86_64|amd64) registry_platform="linux-x86_64" ;;
  aarch64|arm64) registry_platform="linux-aarch64" ;;
  *) fail "unsupported architecture: $(uname -m)" ;;
esac

for command in node curl python3 sha256sum readlink stat; do
  command -v "${command}" >/dev/null 2>&1 || fail "required command is missing: ${command}"
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RELEASE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REGISTRY_MODULE="${RELEASE_DIR}/dist/providers/acpRegistry.js"
[[ -f "${REGISTRY_MODULE}" ]] || fail "compiled ACP registry is unavailable: ${REGISTRY_MODULE}"

registry_row="$(node --input-type=module - "${REGISTRY_MODULE}" "${registry_platform}" <<'NODE'
import { pathToFileURL } from "node:url";
const [modulePath, platform] = process.argv.slice(2);
const registry = await import(pathToFileURL(modulePath).href);
const entry = registry.getLockedAcpRegistryEntry("agy");
const binary = entry?.distribution?.binary?.[platform];
if (!entry?.version || !binary?.archive || !binary?.cmd) process.exit(2);
process.stdout.write([entry.version, binary.archive, binary.cmd, binary.sha256 ?? "-"].join("\t"));
NODE
)" || fail "release-locked Agy ACP binary metadata is unavailable for ${registry_platform}"
IFS=$'\t' read -r VERSION ARCHIVE_URL REGISTRY_CMD ARCHIVE_SHA <<<"${registry_row}"
[[ -n "${VERSION}" && -n "${ARCHIVE_URL}" && -n "${REGISTRY_CMD}" ]] || fail "invalid release-locked Agy ACP metadata"
if [[ "${ARCHIVE_SHA}" == "-" ]]; then ARCHIVE_SHA=""; fi
if [[ -n "${ARCHIVE_SHA}" && ! "${ARCHIVE_SHA}" =~ ^[0-9a-f]{64}$ ]]; then
  fail "invalid release-locked Agy ACP archive checksum"
fi

ROOT="${AGENT_BRIDGE_AGY_ACP_ROOT:-/opt/agent-bridge/host-components/agy-acp}"
LINK="${AGENT_BRIDGE_AGY_ACP_LINK:-/usr/local/bin/agy_acp_server.par}"
COMPONENT_DIR="${ROOT}/components/${VERSION}/${registry_platform}"
BINARY="${COMPONENT_DIR}/agy_acp_server.par"
MANIFEST="${COMPONENT_DIR}/manifest.json"
CHANGED=0

[[ "${ROOT}" == /* && "${LINK}" == /* ]] || fail "managed paths must be absolute"
[[ ! -L "${ROOT}" ]] || fail "Agy ACP root must not be a symlink"
mkdir -p "${ROOT}/components"
chown root:root "${ROOT}" "${ROOT}/components"
chmod 0755 "${ROOT}" "${ROOT}/components"

valid_component() {
  [[ -d "${COMPONENT_DIR}" && ! -L "${COMPONENT_DIR}" && -x "${BINARY}" && -f "${MANIFEST}" && ! -L "${MANIFEST}" ]] || return 1
  python3 - "${MANIFEST}" "${BINARY}" "${VERSION}" "${ARCHIVE_URL}" "${registry_platform}" "${ARCHIVE_SHA}" <<'PY'
import hashlib, json, pathlib, stat, sys
manifest_path = pathlib.Path(sys.argv[1])
binary = pathlib.Path(sys.argv[2])
version, archive_url, platform, archive_sha = sys.argv[3:7]
try:
    manifest_stat = manifest_path.lstat()
    binary_stat = binary.lstat()
    if not stat.S_ISREG(manifest_stat.st_mode) or not stat.S_ISREG(binary_stat.st_mode):
        raise ValueError("managed files must be regular")
    if manifest_stat.st_uid != 0 or binary_stat.st_uid != 0:
        raise ValueError("managed files must be root-owned")
    if manifest_stat.st_mode & 0o022 or binary_stat.st_mode & 0o022:
        raise ValueError("managed files must not be group/world writable")
    if not binary_stat.st_mode & 0o111:
        raise ValueError("managed binary is not executable")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    expected = {"schemaVersion": 1, "version": version, "archiveUrl": archive_url, "platform": platform}
    if any(manifest.get(key) != value for key, value in expected.items()):
        raise ValueError("manifest identity mismatch")
    if archive_sha and manifest.get("archiveSha256") != archive_sha:
        raise ValueError("archive checksum identity mismatch")
    digest = hashlib.sha256(binary.read_bytes()).hexdigest()
    if manifest.get("binarySha256") != digest:
        raise ValueError("binary checksum mismatch")
except Exception:
    raise SystemExit(1)
PY
}

if ! valid_component; then
  work="$(mktemp -d "${ROOT}/.install-${VERSION}.XXXXXX")"
  trap 'rm -rf -- "${work:-}"' EXIT
  archive="${work}/agy-acp.zip"
  staging="${work}/component"
  mkdir -p "${staging}"
  curl --fail --location --silent --show-error --retry 3 --output "${archive}" "${ARCHIVE_URL}"
  downloaded_archive_sha="$(sha256sum "${archive}" | awk '{print $1}')"
  if [[ -n "${ARCHIVE_SHA}" && "${downloaded_archive_sha}" != "${ARCHIVE_SHA}" ]]; then
    fail "release-locked Agy ACP archive checksum mismatch"
  fi
  python3 - "${archive}" "${staging}/agy_acp_server.par" "${REGISTRY_CMD}" <<'PY'
import pathlib, sys, zipfile
archive = pathlib.Path(sys.argv[1])
destination = pathlib.Path(sys.argv[2])
registry_cmd = pathlib.PurePosixPath(sys.argv[3]).name
with zipfile.ZipFile(archive) as bundle:
    matches = [item for item in bundle.infolist() if not item.is_dir() and pathlib.PurePosixPath(item.filename).name == registry_cmd]
    if len(matches) != 1:
        raise SystemExit(f"expected exactly one {registry_cmd} in Agy ACP archive, found {len(matches)}")
    destination.write_bytes(bundle.read(matches[0]))
PY
  chmod 0555 "${staging}/agy_acp_server.par"
  chown root:root "${staging}/agy_acp_server.par"
  binary_sha="$(sha256sum "${staging}/agy_acp_server.par" | awk '{print $1}')"
  python3 - "${staging}/manifest.json" "${VERSION}" "${ARCHIVE_URL}" "${registry_platform}" "${binary_sha}" "${ARCHIVE_SHA}" <<'PY'
import json, pathlib, sys
path = pathlib.Path(sys.argv[1])
manifest = {
    "schemaVersion": 1,
    "version": sys.argv[2],
    "archiveUrl": sys.argv[3],
    "platform": sys.argv[4],
    "binarySha256": sys.argv[5],
}
if sys.argv[6]:
    manifest["archiveSha256"] = sys.argv[6]
path.write_text(json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
PY
  chmod 0444 "${staging}/manifest.json"
  chown root:root "${staging}/manifest.json"
  mkdir -p "$(dirname "${COMPONENT_DIR}")"
  rm -rf -- "${COMPONENT_DIR}.new"
  mv "${staging}" "${COMPONENT_DIR}.new"
  rm -rf -- "${COMPONENT_DIR}"
  mv "${COMPONENT_DIR}.new" "${COMPONENT_DIR}"
  CHANGED=1
fi

valid_component || fail "installed Agy ACP component failed identity/checksum validation"
mkdir -p "$(dirname "${LINK}")"
current_target="$(readlink -f "${LINK}" 2>/dev/null || true)"
if [[ "${current_target}" != "${BINARY}" ]]; then
  ln -sfn "${BINARY}" "${LINK}.new"
  mv -Tf "${LINK}.new" "${LINK}"
  CHANGED=1
fi
[[ -x "${LINK}" ]] || fail "managed Agy ACP link is not executable"
[[ "$(readlink -f "${LINK}")" == "${BINARY}" ]] || fail "managed Agy ACP link points outside the release-locked component"

if (( CHANGED )); then
  echo "host_component_status=converged"
else
  echo "host_component_status=no_op"
fi