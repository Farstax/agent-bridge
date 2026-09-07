#!/usr/bin/env bash
set -euo pipefail

DEFAULT_STT_ROOT="/opt/agent-bridge/host-components/voice-stt"
STT_ROOT="${AGENT_BRIDGE_STT_ROOT:-${DEFAULT_STT_ROOT}}"
SHARED_ENV_FILE="${AGENT_BRIDGE_SHARED_ENV_FILE:-/etc/default/agent-bridge-shared}"
COMPONENTS_DIR="${STT_ROOT}/components"
MODELS_DIR="${STT_ROOT}/models"
CURRENT_LINK="${STT_ROOT}/current"
PREVIOUS_LINK="${STT_ROOT}/previous"
WHISPER_RELEASE="b4938"
WHISPER_SOURCE_COMMIT="52a939a2a762224e255d366c1182b2af4dd1a032"
WHISPER_ARCHIVE="whisper-bin-ubuntu-x64.tar.gz"
WHISPER_ARCHIVE_SHA256="f4cfc1f969a13805908fb72043ce7cc896eb42e0b8afbe841dc8e7298923b061"
WHISPER_ARCHIVE_URL="https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_RELEASE}/${WHISPER_ARCHIVE}"
MODEL_NAME="ggml-base.en-q5_1.bin"
MODEL_SHA256="4baf70dd0d7c4247ba2b81fafd9c01005ac77c2f9ef064e00dcf195d0e2fdd2f"
MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_NAME}"
FFMPEG_PACKAGE_VERSION="7:6.1.1-3ubuntu5"
COMPONENT_DIR="${COMPONENTS_DIR}/${WHISPER_RELEASE}"
CHANGED=0
SHARED_ENV_TMP=""

fail() {
  echo "install-voice-stt: $*" >&2
  exit 1
}

[[ "$(id -u)" == "0" ]] || fail "must run as root"
[[ "$(uname -s)" == "Linux" ]] || fail "whisper.cpp appliance component is supported only on Linux"
case "$(uname -m)" in
  x86_64|amd64) ;;
  *) fail "standard voice transcription component requires x86_64" ;;
esac
[[ "${STT_ROOT}" == /* && "${STT_ROOT}" != *$'\n'* && "${STT_ROOT}" != *$'\r'* ]] \
  || fail "AGENT_BRIDGE_STT_ROOT must be a canonical absolute path"
[[ "${SHARED_ENV_FILE}" == /* && "${SHARED_ENV_FILE}" != *$'\n'* && "${SHARED_ENV_FILE}" != *$'\r'* ]] \
  || fail "AGENT_BRIDGE_SHARED_ENV_FILE must be an absolute path"

for command in curl tar sha256sum python3 apt-get dpkg-query find readlink timeout flock nice stat awk cmp; do
  command -v "${command}" >/dev/null 2>&1 || fail "required command is missing: ${command}"
done

if [[ "${STT_ROOT}" == "${DEFAULT_STT_ROOT}" ]]; then
  for ancestor in /opt/agent-bridge /opt/agent-bridge/host-components; do
    [[ ! -e "${ancestor}" || ( -d "${ancestor}" && ! -L "${ancestor}" ) ]] \
      || fail "canonical STT ancestor is not a regular directory: ${ancestor}"
    mkdir -p "${ancestor}"
    chown root:root "${ancestor}"
    chmod 0755 "${ancestor}"
  done
  for ancestor in /opt /opt/agent-bridge /opt/agent-bridge/host-components; do
    [[ -d "${ancestor}" && ! -L "${ancestor}" ]] || fail "canonical STT ancestor is unsafe: ${ancestor}"
    read -r ancestor_uid ancestor_mode < <(stat -c '%u %a' "${ancestor}")
    (( ancestor_uid == 0 )) || fail "canonical STT ancestor is not root-owned: ${ancestor}"
    (( (8#${ancestor_mode} & 8#022) == 0 )) || fail "canonical STT ancestor is group/world writable: ${ancestor}"
    (( (8#${ancestor_mode} & 8#001) != 0 )) || fail "canonical STT ancestor is not runtime-traversable: ${ancestor}"
  done
fi

[[ ! -L "${STT_ROOT}" ]] || fail "STT root must not be a symlink"
mkdir -p "${COMPONENTS_DIR}" "${MODELS_DIR}"
chown root:root "${STT_ROOT}" "${COMPONENTS_DIR}" "${MODELS_DIR}"
chmod 0755 "${STT_ROOT}" "${COMPONENTS_DIR}" "${MODELS_DIR}"

installed_ffmpeg="$(dpkg-query -W -f='${Version}' ffmpeg 2>/dev/null || true)"
if [[ "${installed_ffmpeg}" != "${FFMPEG_PACKAGE_VERSION}" ]]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y --no-install-recommends "ffmpeg=${FFMPEG_PACKAGE_VERSION}"
  CHANGED=1
fi
[[ -x /usr/bin/ffmpeg && -x /usr/bin/ffprobe ]] || fail "pinned ffmpeg installation did not provide ffmpeg and ffprobe"
[[ "$(dpkg-query -W -f='${Version}' ffmpeg 2>/dev/null || true)" == "${FFMPEG_PACKAGE_VERSION}" ]] \
  || fail "ffmpeg package version does not match ${FFMPEG_PACKAGE_VERSION}"

work="$(mktemp -d "${STT_ROOT}/.install-${WHISPER_RELEASE}.XXXXXX")"
cleanup() {
  rm -rf -- "${work}"
  [[ -z "${SHARED_ENV_TMP}" ]] || rm -f -- "${SHARED_ENV_TMP}"
}
trap cleanup EXIT
chmod 0700 "${work}"

ensure_model() {
  local model_path="${MODELS_DIR}/${MODEL_NAME}"
  if [[ -f "${model_path}" ]] && [[ "$(sha256sum "${model_path}" | awk '{print $1}')" == "${MODEL_SHA256}" ]]; then
    chown root:root "${model_path}"
    chmod 0444 "${model_path}"
    return
  fi
  local candidate="${work}/${MODEL_NAME}"
  curl --fail --location --silent --show-error --retry 3 --output "${candidate}" "${MODEL_URL}"
  echo "${MODEL_SHA256}  ${candidate}" | sha256sum --check --status \
    || fail "voice model checksum mismatch"
  chown root:root "${candidate}"
  chmod 0444 "${candidate}"
  mv -f "${candidate}" "${model_path}"
  CHANGED=1
}

valid_component() {
  [[ -d "${COMPONENT_DIR}" && ! -L "${COMPONENT_DIR}" && -f "${COMPONENT_DIR}/manifest.json" ]] || return 1
  python3 - "${COMPONENT_DIR}" "${MODELS_DIR}/${MODEL_NAME}" <<'PY'
import hashlib, json, os, pathlib, stat, sys
component = pathlib.Path(sys.argv[1])
model = pathlib.Path(sys.argv[2])

def safe_owned(path: pathlib.Path, *, kind: str, executable: bool = False) -> None:
    metadata = path.lstat()
    if stat.S_ISLNK(metadata.st_mode):
        raise ValueError(f"{kind} is a symlink")
    if kind == "directory":
        if not stat.S_ISDIR(metadata.st_mode):
            raise ValueError(f"{kind} is not a directory")
    elif not stat.S_ISREG(metadata.st_mode):
        raise ValueError(f"{kind} is not a regular file")
    if metadata.st_uid != 0 or metadata.st_mode & 0o022:
        raise ValueError(f"{kind} ownership or mode is unsafe")
    if executable and not metadata.st_mode & 0o111:
        raise ValueError(f"{kind} is not executable")

try:
    safe_owned(component, kind="directory")
    manifest_path = component / "manifest.json"
    safe_owned(manifest_path, kind="manifest")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    expected = {
        "schemaVersion": 1,
        "whisperRelease": "b4938",
        "whisperSourceCommit": "52a939a2a762224e255d366c1182b2af4dd1a032",
        "whisperArchiveSha256": "f4cfc1f969a13805908fb72043ce7cc896eb42e0b8afbe841dc8e7298923b061",
        "model": "ggml-base.en-q5_1.bin",
        "modelSha256": "4baf70dd0d7c4247ba2b81fafd9c01005ac77c2f9ef064e00dcf195d0e2fdd2f",
        "ffmpegPackageVersion": "7:6.1.1-3ubuntu5",
    }
    if any(manifest.get(k) != v for k, v in expected.items()):
        raise ValueError("manifest identity mismatch")
    executable = (component / manifest["whisperExecutable"]).resolve()
    if component.resolve() not in executable.parents or not executable.is_file():
        raise ValueError("unsafe executable path")
    safe_owned(executable, kind="whisper executable", executable=True)
    safe_owned(model, kind="model")
    def sha(path):
        h = hashlib.sha256()
        with path.open("rb") as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b""):
                h.update(chunk)
        return h.hexdigest()
    if sha(executable) != manifest.get("whisperExecutableSha256"):
        raise ValueError("executable checksum mismatch")
    if sha(model) != expected["modelSha256"]:
        raise ValueError("model checksum mismatch")
except Exception:
    raise SystemExit(1)
PY
}

install_component() {
  local archive="${work}/${WHISPER_ARCHIVE}"
  local staging="${work}/component"
  mkdir -p "${staging}"
  curl --fail --location --silent --show-error --retry 3 --output "${archive}" "${WHISPER_ARCHIVE_URL}"
  echo "${WHISPER_ARCHIVE_SHA256}  ${archive}" | sha256sum --check --status \
    || fail "whisper.cpp archive checksum mismatch"
  tar -xzf "${archive}" -C "${staging}" --no-same-owner

  python3 - "${staging}" <<'PY'
import pathlib, sys
root = pathlib.Path(sys.argv[1]).resolve()
for path in root.rglob("*"):
    if not path.is_symlink():
        continue
    target = (path.parent / path.readlink()).resolve()
    if root != target and root not in target.parents:
        raise SystemExit(f"escaping symlink in whisper.cpp archive: {path}")
PY

  local whisper_path
  whisper_path="$(find "${staging}" -type f -name whisper-cli -print -quit)"
  [[ -n "${whisper_path}" ]] || fail "whisper.cpp archive does not contain whisper-cli"
  local relative_whisper="${whisper_path#${staging}/}"
  local whisper_sha
  whisper_sha="$(sha256sum "${whisper_path}" | awk '{print $1}')"

  chown -R root:root "${staging}"
  find "${staging}" -type d -exec chmod 0555 {} +
  find "${staging}" -type f -exec chmod 0444 {} +
  chmod 0555 "${whisper_path}"

  python3 - "${staging}/manifest.json" "${relative_whisper}" "${whisper_sha}" <<'PY'
import json, pathlib, sys
path = pathlib.Path(sys.argv[1])
manifest = {
    "schemaVersion": 1,
    "whisperRelease": "b4938",
    "whisperSourceCommit": "52a939a2a762224e255d366c1182b2af4dd1a032",
    "whisperArchiveSha256": "f4cfc1f969a13805908fb72043ce7cc896eb42e0b8afbe841dc8e7298923b061",
    "whisperExecutable": sys.argv[2],
    "whisperExecutableSha256": sys.argv[3],
    "model": "ggml-base.en-q5_1.bin",
    "modelSha256": "4baf70dd0d7c4247ba2b81fafd9c01005ac77c2f9ef064e00dcf195d0e2fdd2f",
    "ffmpegPackageVersion": "7:6.1.1-3ubuntu5",
}
path.write_text(json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
PY
  chown root:root "${staging}/manifest.json"
  chmod 0444 "${staging}/manifest.json"

  rm -rf -- "${COMPONENT_DIR}.new"
  mv "${staging}" "${COMPONENT_DIR}.new"
  rm -rf -- "${COMPONENT_DIR}"
  mv "${COMPONENT_DIR}.new" "${COMPONENT_DIR}"
  CHANGED=1
}

publish_shared_runtime_contract() {
  [[ -f "${SHARED_ENV_FILE}" && ! -L "${SHARED_ENV_FILE}" ]] \
    || fail "shared runtime environment is unavailable: ${SHARED_ENV_FILE}"
  local shared_parent
  shared_parent="$(dirname "${SHARED_ENV_FILE}")"
  [[ -d "${shared_parent}" && ! -L "${shared_parent}" ]] \
    || fail "shared runtime environment parent is unsafe: ${shared_parent}"
  SHARED_ENV_TMP="$(mktemp "${SHARED_ENV_FILE}.new.XXXXXX")"
  awk '$0 !~ /^AGENT_BRIDGE_STT_ROOT=/' "${SHARED_ENV_FILE}" > "${SHARED_ENV_TMP}"
  printf 'AGENT_BRIDGE_STT_ROOT=%s\n' "${STT_ROOT}" >> "${SHARED_ENV_TMP}"
  chown --reference="${SHARED_ENV_FILE}" "${SHARED_ENV_TMP}"
  chmod --reference="${SHARED_ENV_FILE}" "${SHARED_ENV_TMP}"
  if cmp -s "${SHARED_ENV_TMP}" "${SHARED_ENV_FILE}"; then
    rm -f -- "${SHARED_ENV_TMP}"
    SHARED_ENV_TMP=""
    return
  fi
  mv -f "${SHARED_ENV_TMP}" "${SHARED_ENV_FILE}"
  SHARED_ENV_TMP=""
  CHANGED=1
}

ensure_model
if ! valid_component; then
  install_component
fi
valid_component || fail "installed voice transcription component failed checksum validation"

manifest_whisper="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["whisperExecutable"])' "${COMPONENT_DIR}/manifest.json")"
whisper_path="${COMPONENT_DIR}/${manifest_whisper}"
"${whisper_path}" --version >/dev/null 2>&1 || fail "whisper-cli version preflight failed"

smoke_dir="${work}/smoke"
mkdir -p "${smoke_dir}"
/usr/bin/ffmpeg -nostdin -hide_banner -loglevel error -y -f lavfi -i anullsrc=r=16000:cl=mono -t 0.25 "${smoke_dir}/silence.wav"
timeout 20s /usr/bin/nice -n 19 "${whisper_path}" \
  -m "${MODELS_DIR}/${MODEL_NAME}" -f "${smoke_dir}/silence.wav" \
  -t 1 -p 1 -bs 1 -bo 1 -l en -np >/dev/null 2>&1 \
  || fail "whisper.cpp local smoke test failed"

new_target="components/${WHISPER_RELEASE}"
old_target=""
if [[ -L "${CURRENT_LINK}" ]]; then
  old_target="$(readlink "${CURRENT_LINK}")"
  case "${old_target}" in
    components/*) ;;
    *) fail "existing voice current pointer is outside the managed component namespace" ;;
  esac
fi
if [[ -n "${old_target}" && "${old_target}" != "${new_target}" ]]; then
  ln -sfn "${old_target}" "${PREVIOUS_LINK}.new"
  mv -Tf "${PREVIOUS_LINK}.new" "${PREVIOUS_LINK}"
fi
if [[ "${old_target}" != "${new_target}" ]]; then
  ln -sfn "${new_target}" "${CURRENT_LINK}.new"
  mv -Tf "${CURRENT_LINK}.new" "${CURRENT_LINK}"
  CHANGED=1
fi
chown -h root:root "${CURRENT_LINK}" 2>/dev/null || true
[[ ! -L "${PREVIOUS_LINK}" ]] || chown -h root:root "${PREVIOUS_LINK}" 2>/dev/null || true

publish_shared_runtime_contract

status="no_op"
[[ "${CHANGED}" == "0" ]] || status="converged"
echo "voice STT ready: whisper.cpp ${WHISPER_RELEASE}, ${MODEL_NAME}, ffmpeg ${FFMPEG_PACKAGE_VERSION}"
echo "host_component_status=${status}"
