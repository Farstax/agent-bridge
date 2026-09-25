#!/usr/bin/env bash
set -euo pipefail

fail() { echo "install-cursor-acp: $*" >&2; exit 1; }

print_required_bytes=0
if [[ "${1:-}" == "--print-required-bytes" ]]; then
  print_required_bytes=1
fi
phase="${AGENT_BRIDGE_HOST_COMPONENT_PHASE:-converge}"
[[ "$phase" == prepare || "$phase" == commit || "$phase" == converge ]] || fail "invalid host component phase"

# Guarded activation selects the account; the installer itself runs as that
# account so root never follows or writes through user-controlled paths.
RUNTIME_USER="${AGENT_BRIDGE_CURSOR_ACP_USER:-}"
[[ "${RUNTIME_USER}" =~ ^[a-z_][a-z0-9_-]*[$]?$ ]] || fail "AGENT_BRIDGE_CURSOR_ACP_USER is required"
[[ "$(id -un)" == "${RUNTIME_USER}" ]] || fail "must run as ${RUNTIME_USER}"
RUNTIME_HOME="${HOME:-}"
[[ "${RUNTIME_HOME}" == /* && -d "${RUNTIME_HOME}" && ! -L "${RUNTIME_HOME}" ]] || fail "runtime user home is unavailable"

case "$(uname -s):$(uname -m)" in
  Linux:x86_64|Linux:amd64) PLATFORM="linux-x86_64" ;;
  Linux:aarch64|Linux:arm64) PLATFORM="linux-aarch64" ;;
  Darwin:arm64) PLATFORM="darwin-aarch64" ;;
  Darwin:x86_64) PLATFORM="darwin-x86_64" ;;
  *) fail "unsupported platform: $(uname -s) $(uname -m)" ;;
esac
for command in node curl tar mktemp install sha256sum readlink df find cp rm; do command -v "${command}" >/dev/null || fail "missing ${command}"; done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RELEASE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REGISTRY_MODULE="${RELEASE_DIR}/dist/providers/acpRegistry.js"
[[ -f "${REGISTRY_MODULE}" ]] || fail "compiled ACP registry is unavailable"
ROW="$(node --input-type=module - "${REGISTRY_MODULE}" "${PLATFORM}" <<'NODE'
import { pathToFileURL } from "node:url";
const [modulePath, platform] = process.argv.slice(2);
const { getLockedAcpRegistryEntry } = await import(pathToFileURL(modulePath).href);
const entry = getLockedAcpRegistryEntry("cursor");
const binary = entry?.distribution?.binary?.[platform];
if (!entry?.version || !binary?.archive || !binary?.sha256 || !binary?.cmd) process.exit(2);
process.stdout.write([entry.version, binary.archive, binary.sha256, binary.cmd].join("\t"));
NODE
)" || fail "release-locked Cursor metadata unavailable"
IFS=$'\t' read -r VERSION ARCHIVE_URL ARCHIVE_SHA REGISTRY_CMD <<<"${ROW}"
RELATIVE_CMD="${REGISTRY_CMD#./}"
[[ "${RELATIVE_CMD}" == dist-package/* && "${RELATIVE_CMD}" != *".."* ]] || fail "unsafe archive command"

ROOT="${RUNTIME_HOME}/.local/share/agent-bridge/cursor-acp"
LINK="${RUNTIME_HOME}/.local/bin/cursor-agent"
VERSION_DIR="${ROOT}/versions/${VERSION}"
BINARY="${VERSION_DIR}/${RELATIVE_CMD}"
CHANGED=0

valid_binary() {
  [[ -x "${BINARY}" ]] && [[ "$("${BINARY}" --version 2>/dev/null || true)" == *"${VERSION}"* ]]
}

if valid_binary; then
  if (( print_required_bytes == 1 )); then
    printf '0\n'
    exit 0
  fi
else
  [[ "$phase" != commit ]] || fail "prepared Cursor ACP binary is missing"
  remote_length="$(curl --fail --location --silent --show-error --head "${ARCHIVE_URL}" \
    | tr -d '\r' | awk 'tolower($1) == "content-length:" {print $2; exit}')" \
    || fail "unable to determine Cursor ACP archive size before download"
  [[ "${remote_length}" =~ ^[0-9]+$ ]] || fail "Cursor ACP archive did not report a numeric Content-Length"
  safety_factor="${AGENT_BRIDGE_CURSOR_ACP_DISK_SAFETY_FACTOR:-4}"
  required_bytes=$(( remote_length * safety_factor ))
  if (( print_required_bytes == 1 )); then
    printf '%s\n' "${required_bytes}"
    exit 0
  fi
  available_bytes="$(df --output=avail -B1 "${RUNTIME_HOME}" 2>/dev/null | tail -1 | tr -d '[:space:]')"
  [[ "${available_bytes}" =~ ^[0-9]+$ ]] || fail "unable to determine available disk space at ${RUNTIME_HOME}"
  if (( available_bytes < required_bytes )); then
    fail "insufficient disk space to stage Cursor ACP component: need ~${required_bytes} bytes (archive ${remote_length} bytes x${safety_factor} safety factor), have ${available_bytes} bytes available at ${RUNTIME_HOME}"
  fi

  install -d -m 0755 "${ROOT}/versions" "$(dirname "${LINK}")"
  STAGING="$(mktemp -d "${ROOT}/.install-${VERSION}.XXXXXX")"
  cleanup() { rm -rf -- "${STAGING}"; }
  trap cleanup EXIT
  ARCHIVE="${STAGING}/cursor-agent.tar.gz"
  curl --fail --location --silent --show-error --output "${ARCHIVE}" "${ARCHIVE_URL}"
  [[ "$(sha256sum "${ARCHIVE}" | cut -d' ' -f1)" == "${ARCHIVE_SHA}" ]] || fail "Cursor archive SHA-256 mismatch"
  tar -xzf "${ARCHIVE}" -C "${STAGING}"
  PACKAGE_DIR="${STAGING}/dist-package"
  [[ -d "${PACKAGE_DIR}" && ! -L "${PACKAGE_DIR}" ]] || fail "archive omitted dist-package runtime"
  [[ -f "${STAGING}/${RELATIVE_CMD}" && ! -L "${STAGING}/${RELATIVE_CMD}" ]] || fail "archive omitted ${RELATIVE_CMD}"
  archive_symlink="$(find "${PACKAGE_DIR}" -type l -print -quit)"
  [[ -z "${archive_symlink}" ]] || fail "Cursor archive package contains a symlink"
  [[ ! -e "${VERSION_DIR}" || ( -d "${VERSION_DIR}" && ! -L "${VERSION_DIR}" ) ]] || fail "unsafe Cursor version directory"
  install -d -m 0755 "${VERSION_DIR}"
  rm -rf -- "${VERSION_DIR}/dist-package"
  cp -a -- "${PACKAGE_DIR}" "${VERSION_DIR}/"
  [[ "$("${BINARY}" --version 2>/dev/null || true)" == *"${VERSION}"* ]] || fail "installed binary did not report ${VERSION}"
  CHANGED=1
fi

valid_binary || fail "installed Cursor ACP binary failed validation"
if [[ "$phase" == prepare ]]; then
  if (( CHANGED )); then
    echo "host_component_status=converged"
  else
    echo "host_component_status=no_op"
  fi
  exit 0
fi

install -d -m 0755 "$(dirname "${LINK}")"
current_target="$(readlink "${LINK}" 2>/dev/null || true)"
if [[ "${current_target}" != "${BINARY}" ]]; then
  ln -sfn "${BINARY}" "${LINK}"
  CHANGED=1
fi

if (( CHANGED )); then
  echo "host_component_status=converged"
else
  echo "host_component_status=no_op"
fi
