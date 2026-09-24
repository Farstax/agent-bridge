#!/usr/bin/env bash
set -euo pipefail

fail() { echo "install-cursor-acp: $*" >&2; exit 1; }

# This runs only through guarded release activation. Cursor remains owned by
# the bridge account even though activation performs the privileged staging.
[[ "$(id -u)" == "0" ]] || fail "must run under guarded root activation"
RUNTIME_USER="${AGENT_BRIDGE_CURSOR_ACP_USER:-}"
[[ "${RUNTIME_USER}" =~ ^[a-z_][a-z0-9_-]*[$]?$ ]] || fail "AGENT_BRIDGE_CURSOR_ACP_USER is required"
RUNTIME_HOME="$(getent passwd "${RUNTIME_USER}" | cut -d: -f6)"
[[ "${RUNTIME_HOME}" == /* && -d "${RUNTIME_HOME}" ]] || fail "runtime user home is unavailable"

case "$(uname -s):$(uname -m)" in
  Linux:x86_64|Linux:amd64) PLATFORM="linux-x86_64" ;;
  Linux:aarch64|Linux:arm64) PLATFORM="linux-aarch64" ;;
  Darwin:arm64) PLATFORM="darwin-aarch64" ;;
  Darwin:x86_64) PLATFORM="darwin-x86_64" ;;
  *) fail "unsupported platform: $(uname -s) $(uname -m)" ;;
esac
for command in node curl tar mktemp install getent readlink; do command -v "${command}" >/dev/null || fail "missing ${command}"; done

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
if (!entry?.version || !binary?.archive || !binary?.cmd) process.exit(2);
process.stdout.write([entry.version, binary.archive, binary.cmd].join("\t"));
NODE
)" || fail "release-locked Cursor metadata unavailable"
IFS=$'\t' read -r VERSION ARCHIVE_URL REGISTRY_CMD <<<"${ROW}"
RELATIVE_CMD="${REGISTRY_CMD#./}"
[[ "${RELATIVE_CMD}" == dist-package/* && "${RELATIVE_CMD}" != *".."* ]] || fail "unsafe archive command"

ROOT="${RUNTIME_HOME}/.local/share/agent-bridge/cursor-acp"
LINK="${RUNTIME_HOME}/.local/bin/cursor-agent"
VERSION_DIR="${ROOT}/versions/${VERSION}"
BINARY="${VERSION_DIR}/${RELATIVE_CMD}"
if [[ -x "${BINARY}" ]] && [[ "$("${BINARY}" --version 2>/dev/null || true)" == *"${VERSION}"* ]]; then
  install -d -o "${RUNTIME_USER}" -g "${RUNTIME_USER}" -m 0755 "$(dirname "${LINK}")"
  ln -sfn "${BINARY}" "${LINK}"
  chown -h "${RUNTIME_USER}:${RUNTIME_USER}" "${LINK}"
  echo "host_component_status=no_op"
  exit 0
fi

install -d -o "${RUNTIME_USER}" -g "${RUNTIME_USER}" -m 0755 "${ROOT}/versions" "$(dirname "${LINK}")"
STAGING="$(mktemp -d "${ROOT}/.install-${VERSION}.XXXXXX")"
cleanup() { rm -rf -- "${STAGING}"; }
trap cleanup EXIT
ARCHIVE="${STAGING}/cursor-agent.tar.gz"
curl --fail --location --silent --show-error --output "${ARCHIVE}" "${ARCHIVE_URL}"
tar -xzf "${ARCHIVE}" -C "${STAGING}"
[[ -f "${STAGING}/${RELATIVE_CMD}" && ! -L "${STAGING}/${RELATIVE_CMD}" ]] || fail "archive omitted ${RELATIVE_CMD}"
install -d -o "${RUNTIME_USER}" -g "${RUNTIME_USER}" -m 0755 "${VERSION_DIR}/$(dirname "${RELATIVE_CMD}")"
install -o "${RUNTIME_USER}" -g "${RUNTIME_USER}" -m 0755 "${STAGING}/${RELATIVE_CMD}" "${BINARY}"
[[ "$("${BINARY}" --version 2>/dev/null || true)" == *"${VERSION}"* ]] || fail "installed binary did not report ${VERSION}"
ln -sfn "${BINARY}" "${LINK}"
chown -h "${RUNTIME_USER}:${RUNTIME_USER}" "${LINK}"
echo "host_component_status=converged"
