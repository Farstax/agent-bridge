#!/usr/bin/env bash
# Shared accepted-release retention. Source only from a verified release tree.
# Callers own acceptance, lifecycle locking, and the set of retained releases
# and effective service/environment consumers. This file owns component proof
# and reclamation, never activation or rollback.

# Provider binaries are versioned host components installed beside, never
# inside, immutable releases. After acceptance the only releases that can run
# are the new current release and the previous (rollback) release, so any
# installed provider version neither pins is obsolete. Every ambiguity skips
# pruning: the rollout is already accepted and must not fail on hygiene.
locked_host_component_version() {
  local release_dir="$1" provider="$2" module="$1/dist/providers/acpRegistry.js" field="${3:-version}" platform="${4:-linux-x86_64}"
  [[ -f "$module" && ! -L "$module" ]] || return 1
  "$node_bin" --input-type=module - "$module" "$provider" "$field" "$platform" <<'NODE'
import { pathToFileURL } from "node:url";
const [modulePath, provider, field, platform] = process.argv.slice(2);
const { getLockedAcpRegistryEntry } = await import(pathToFileURL(modulePath).href);
const entry = getLockedAcpRegistryEntry(provider);
const version = entry?.version;
if (typeof version !== "string" || !/^[0-9A-Za-z][0-9A-Za-z._+-]*$/.test(version)) process.exit(2);
if (field === "agy-pin") {
  const command = entry.distribution?.binary?.[platform]?.cmd;
  if (command !== "./agy" && command !== "./agy_acp_server.par") process.exit(2);
  process.stdout.write(version + "\t" + command);
} else {
  process.stdout.write(version);
}
NODE
}

# A version directory is deletable only when it carries the identity record its
# own installer writes: Agy's per-platform manifest naming this exact version,
# Cursor's recorded payload digest beside its payload directory.
agy_managed_manifest() {
  local entry="$1" name="$2" manifest
  while IFS= read -r manifest; do
    [[ -f "$manifest" && ! -L "$manifest" ]] || continue
    if /usr/bin/python3 - "$manifest" "$name" <<'PY'
import json, sys
try:
    manifest = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception:
    raise SystemExit(1)
raise SystemExit(0 if manifest.get("version") == sys.argv[2] and (manifest.get("schemaVersion") == 2 or (manifest.get("schemaVersion") == 3 and manifest.get("binaryName") == "agy" and manifest.get("archiveSha256"))) else 1)
PY
    then
      printf '%s\n' "$manifest"
      return 0
    fi
  done < <(/usr/bin/find "$entry" -mindepth 2 -maxdepth 2 -name manifest.json -print)
  return 1
}

agy_version_dir_is_managed() {
  agy_managed_manifest "$@" >/dev/null
}

# This is intentionally independent of the host rollout's fatal path validator.
agy_retention_secure_path() {
  local path="$1" kind="$2" mode owner canonical
  if [[ "$kind" == directory ]]; then [[ -d "$path" && ! -L "$path" ]] || return 1
  else [[ -f "$path" && ! -L "$path" ]] || return 1
  fi
  canonical="$(/usr/bin/realpath -e -- "$path")" || return 1
  owner="$(/usr/bin/stat -c %u -- "$path")" || return 1
  mode="$(/usr/bin/stat -c %a -- "$path")" || return 1
  [[ "$canonical" == "$path" && "$owner" == "$secure_owner_uid" ]] && (( (8#$mode & 022) == 0 ))
}

# Keep the ownership record until all payloads are removed. A retry after
# interruption can still identify the version; only empty directories can
# remain if interrupted after the final manifest unlink.
remove_agy_version_directory() {
  local root="$1" name="$2" entry manifest parent
  [[ "$name" =~ ^[0-9A-Za-z][0-9A-Za-z._+-]*$ ]] || return 1
  entry="$root/$name"
  manifest="$(agy_managed_manifest "$entry" "$name")" || return 1
  parent="$(/usr/bin/dirname -- "$manifest")"
  ( agy_retention_secure_path "$root" directory && agy_retention_secure_path "$entry" directory \
    && agy_retention_secure_path "$parent" directory && agy_retention_secure_path "$manifest" file ) >/dev/null || return 1
  /usr/bin/find "$entry" -depth -mindepth 1 ! -samefile "$manifest" ! -samefile "$parent" -delete || return 1
  # Recheck the exact root and child immediately before the final removal.
  agy_retention_secure_path "$root" directory && agy_retention_secure_path "$entry" directory || return 1
  /usr/bin/rm -rf -- "$entry"
}

agy_registry_platform() {
  case "$(/usr/bin/uname -m)" in
    x86_64|amd64) printf linux-x86_64 ;;
    aarch64|arm64) printf linux-aarch64 ;;
    *) return 1 ;;
  esac
}

cursor_version_dir_is_managed() {
  local entry="$1"
  [[ -f "$entry/dist-package.sha256" && ! -L "$entry/dist-package.sha256" && -d "$entry/dist-package" && ! -L "$entry/dist-package" ]]
}

# Validate the historical installer output before retiring its links. The
# normal pruner still owns deletion of version directories. Both release
# commands, all present links and the accepted service configuration must
# agree before either legacy link is changed.
agy_legacy_links_allow_pruning() {
  local versions_dir="$1" current_version="$2" previous_version="$3" official_link="$4" platform="$5" rollback_command="$6" current_command="$7"
  local legacy_binary_link="${AGENT_BRIDGE_AGY_LEGACY_LINK:-/usr/local/bin/agy_acp_server.par}"
  local legacy_harness_link="${AGENT_BRIDGE_AGY_HARNESS_LINK:-/usr/local/bin/agy_localharness_external}"
  local module release unit unit_config unit_env
  local -a env_files=("${retention_env_files[@]}")
  if [[ "$current_command" == "./agy" ]]; then
    [[ "$(/usr/bin/readlink -f -- "$official_link")" == "$versions_dir/$current_version/$platform/agy" ]] || return 1
  else
    # With a legacy current pin, the selected link is the legacy executable.
    # A separate official link may still be present, but must not be retired.
    legacy_binary_link="$official_link"
    official_link=/usr/local/bin/agy
  fi
  if [[ "$current_command" == "./agy" && "$rollback_command" == "./agy" ]]; then
    [[ -f "$versions_dir/$previous_version/$platform/agy" && ! -L "$versions_dir/$previous_version/$platform/agy" ]] || return 1
    agy_version_dir_is_managed "$versions_dir/$previous_version" "$previous_version" || return 1
    # An official-version pin alone does not prove an older release knows how
    # to normalize stale service settings. Ask both immutable runtime owners.
    for release in "$current_release_dir" "${rollback_release_dir:-$current_release_dir}"; do
      module="$release/dist/providers/agyAcpConfig.js"
      [[ -f "$module" && ! -L "$module" ]] || return 1
      "$node_bin" --input-type=module - "$module" "$official_link" "$legacy_binary_link" <<'NODE' || return 1
import { pathToFileURL } from "node:url";
const [modulePath, official, legacy] = process.argv.slice(2);
const { resolveAgyAcpCommand } = await import(pathToFileURL(modulePath).href);
for (const command of [undefined, "agy", legacy]) {
  if (resolveAgyAcpCommand({ AGY_ACP_COMMAND: command, AGENT_BRIDGE_AGY_ACP_LINK: official }) !== official) process.exit(1);
}
NODE
    done
  fi
  for unit in "${units[@]}"; do
    unit_config="$("$systemctl_cmd" cat "$unit")" || return 1
    unit_env="$("$systemctl_cmd" show "$unit" --property=Environment --value)" || return 1
    # An explicit version or inline override can select a retired payload.
    for unit_config in "$unit_config" "$unit_env"; do
      [[ "$unit_config" != *"$versions_dir/"* && "$unit_config" != *AGY_ACP_COMMAND* \
        && "$unit_config" != *AGENT_BRIDGE_AGY_ACP_LINK* ]] || return 1
      if [[ "$current_command" == "./agy" && "$rollback_command" == "./agy" ]]; then
        [[ "$unit_config" != *"$legacy_binary_link"* && "$unit_config" != *"$legacy_harness_link"* ]] || return 1
      fi
    done
  done

  /usr/bin/python3 - "$versions_dir" "$current_version" "$previous_version" "$official_link" "$legacy_binary_link" "$legacy_harness_link" "$rollback_command" "$current_command" "$secure_owner_uid" "$platform" "${env_files[@]}" <<'PY'
import hashlib, json, os, pathlib, re, stat, sys
root, current, rollback, official, binary_link, harness_link, rollback_command, current_command, uid, platform, *env_files = sys.argv[1:]
uid = int(uid)
links = {binary_link: "agy_acp_server.par", harness_link: "localharness_external"}

def require(condition):
    if not condition:
        raise ValueError("ambiguous legacy ownership or consumer")

def secure(path, mode_check):
    info = os.lstat(path)
    require(mode_check(info.st_mode) and info.st_uid == uid and not info.st_mode & 0o022)
    require(os.path.realpath(path) == path)

try:
    require(len({official, binary_link, harness_link}) == 3)
    secure(root, stat.S_ISDIR)
    present = {}
    version = None
    for link, artifact in links.items():
        require(os.path.isabs(link) and os.path.normpath(link) == link)
        if not os.path.lexists(link):
            continue
        secure(os.path.dirname(link), stat.S_ISDIR)
        info = os.lstat(link)
        require(stat.S_ISLNK(info.st_mode) and info.st_uid == uid)
        target = os.readlink(link)
        relative = os.path.relpath(target, root).split(os.sep)
        require(len(relative) == 3 and re.fullmatch(r"[0-9A-Za-z][0-9A-Za-z._+-]*", relative[0])
                and relative[1:] == [platform, artifact])
        require(version is None or version == relative[0])
        version = relative[0]
        require(target == os.path.join(root, version, platform, artifact))
        present[link] = (target, info.st_ino, info.st_dev)

    if version is not None:
        directory = os.path.join(root, version, platform)
        secure(os.path.dirname(directory), stat.S_ISDIR)
        secure(directory, stat.S_ISDIR)
        manifest_path = os.path.join(directory, "manifest.json")
        secure(manifest_path, stat.S_ISREG)
        manifest = json.loads(pathlib.Path(manifest_path).read_text())
        require(manifest.get("schemaVersion") == 2 and manifest.get("version") == version
                and manifest.get("platform") == platform
                and manifest.get("harnessName") == "localharness_external"
                and manifest.get("harnessVersion") == version
                and manifest.get("harnessPath") == os.path.join(directory, "localharness_external")
                and re.fullmatch(r"[0-9a-f]{64}", manifest.get("archiveSha256", "")))
        # Both payloads must still be installer-owned, including after the
        # first link of an interrupted retirement has already been removed.
        for name, key in (("agy_acp_server.par", "binarySha256"), ("localharness_external", "harnessSha256")):
            payload = os.path.join(directory, name)
            secure(payload, stat.S_ISREG)
            digest = hashlib.sha256()
            with open(payload, "rb") as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(chunk)
            require(digest.hexdigest() == manifest.get(key))

    retire_legacy = current_command == "./agy" and rollback_command == "./agy"
    if not retire_legacy:
        legacy_pin = current if current_command == "./agy_acp_server.par" else rollback
        require(len(present) == 2 and version == legacy_pin)
    else:
        require(version not in (current, rollback))
    # Check actual path references, not arbitrary substrings in process text.
    old_paths = [entry.path for entry in os.scandir(root)
                 if entry.name not in (current, rollback) and entry.is_dir(follow_symlinks=False)
                 and re.fullmatch(r"[0-9A-Za-z][0-9A-Za-z._+-]*", entry.name)]
    if not present and not old_paths:
        sys.exit(0)
    def retired_path(path):
        path = path.removesuffix(" (deleted)")
        return (retire_legacy and path in links) or any(path == old or path.startswith(old + "/") for old in old_paths)

    if os.path.lexists(official):
        require(not retired_path(os.path.realpath(official)))

    for filename in env_files:
        if not os.path.lexists(filename):
            continue
        with open(filename, encoding="utf-8") as stream:
            for line in stream:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if line in ("AGY_ACP_COMMAND=" + binary_link, "AGY_ACP_COMMAND=agy",
                            "AGY_ACP_COMMAND=" + official, "AGENT_BRIDGE_AGY_ACP_LINK=" + official):
                    continue
                require("AGY_ACP_COMMAND" not in line and "AGENT_BRIDGE_AGY_ACP_LINK" not in line
                        and not any(path in line for path in (binary_link, harness_link, *old_paths)))
    for pid in os.listdir("/proc"):
        if not pid.isdigit() or int(pid) == os.getpid():
            continue
        proc = "/proc/" + pid
        try:
            for name in ("exe", "cwd", *("fd/" + fd for fd in os.listdir(proc + "/fd"))):
                try:
                    require(not retired_path(os.readlink(proc + "/" + name)))
                except FileNotFoundError:
                    pass
            with open(proc + "/cmdline", "rb") as stream:
                require(not any(retired_path(os.fsdecode(arg)) for arg in stream.read().split(b"\x00")))
            with open(proc + "/maps", encoding="utf-8", errors="surrogateescape") as stream:
                for line in stream:
                    fields = line.rstrip("\n").split(maxsplit=5)
                    require(len(fields) < 6 or not retired_path(fields[5]))
        except PermissionError:
            # As in the existing rollout holder scan, only the unprivileged
            # test runner may lack access. Privileged retention fails closed.
            if os.geteuid() == 0:
                raise
        except (FileNotFoundError, ProcessLookupError):
            continue
    # Recheck the complete set before the first mutation. Each subsequent
    # retry accepts an absent partner but never an unmanaged remaining link.
    for link, (target, inode, device) in present.items():
        info = os.lstat(link)
        require(stat.S_ISLNK(info.st_mode) and info.st_ino == inode and info.st_dev == device
                and os.readlink(link) == target)
    if retire_legacy:
        for link in present:
            os.unlink(link)
except OSError as error:
    print(f"host component retention legacy inspection failed errno={error.errno}", file=sys.stderr)
    sys.exit(1)
except (ValueError, TypeError):
    sys.exit(1)
PY
}

prune_host_component_versions() {
  local provider="$1" versions_dir="$2" remover="$3" managed_check="$4" current_release_dir="$5" rollback_release_dir="$6"
  local current_version previous_version link linked entry name platform agy_command rollback_command current_pin rollback_pin pruned=0
  shift 6
  if [[ ! -e "$versions_dir" && ! -L "$versions_dir" ]]; then
    echo "host component retention provider=$provider pruned=0 reason=not_installed"
    return 0
  fi
  [[ -d "$versions_dir" && ! -L "$versions_dir" ]] || { echo "host component retention skipped provider=$provider reason=unsafe_root"; return 0; }
  local pin_field=version
  platform=""
  if [[ "$provider" == agy ]]; then
    platform="$(agy_registry_platform)" \
      || { echo "host component retention skipped provider=agy reason=unsupported_platform"; return 0; }
    pin_field=agy-pin
  fi
  current_pin="$(locked_host_component_version "$current_release_dir" "$provider" "$pin_field" "$platform")" \
    || { echo "host component retention skipped provider=$provider reason=current_pin_unavailable"; return 0; }
  rollback_pin="$(locked_host_component_version "${rollback_release_dir:-$current_release_dir}" "$provider" "$pin_field" "$platform")" \
    || { echo "host component retention skipped provider=$provider reason=rollback_pin_unavailable"; return 0; }
  IFS=$'\t' read -r current_version agy_command <<<"$current_pin"
  IFS=$'\t' read -r previous_version rollback_command <<<"$rollback_pin"
  [[ -d "$versions_dir/$current_version" && ! -L "$versions_dir/$current_version" ]] \
    || { echo "host component retention skipped provider=$provider reason=current_version_not_installed"; return 0; }
  if [[ -n "$(/usr/bin/find "$(/usr/bin/dirname -- "$versions_dir")" -mindepth 1 -maxdepth 1 -name '.install-*' -print -quit)" ]]; then
    echo "host component retention skipped provider=$provider reason=install_in_progress"
    return 0
  fi
  if [[ "$provider" == agy ]]; then
    if [[ "$agy_command" == "./agy" ]]; then
      set -- "${AGENT_BRIDGE_AGY_ACP_LINK:-/usr/local/bin/agy}"
    else
      set -- "${AGENT_BRIDGE_AGY_ACP_LINK:-/usr/local/bin/agy_acp_server.par}" \
        "${AGENT_BRIDGE_AGY_HARNESS_LINK:-/usr/local/bin/agy_localharness_external}"
    fi
  fi
  # Every managed link the installer publishes must already serve the current
  # version; a stale link means activation did not converge.
  for link in "$@"; do
    [[ -L "$link" && -e "$link" ]] || { echo "host component retention skipped provider=$provider reason=link_not_managed"; return 0; }
    linked="$(/usr/bin/readlink -f -- "$link")" || { echo "host component retention skipped provider=$provider reason=link_unresolved"; return 0; }
    [[ "$linked" == "$versions_dir/$current_version/"* ]] \
      || { echo "host component retention skipped provider=$provider reason=link_not_current"; return 0; }
  done
  if [[ "$provider" == agy ]]; then
    if ! agy_legacy_links_allow_pruning "$versions_dir" "$current_version" "$previous_version" "$1" "$platform" "$rollback_command" "$agy_command"; then
      echo "host component retention skipped provider=agy reason=legacy_link_ownership_or_consumer_ambiguous"
      return 0
    fi
  fi
  while IFS= read -r entry; do
    name="$(/usr/bin/basename -- "$entry")"
    [[ "$name" =~ ^[0-9A-Za-z][0-9A-Za-z._+-]*$ ]] || continue
    [[ "$name" != "$current_version" && "$name" != "$previous_version" ]] || continue
    [[ -d "$entry" && ! -L "$entry" ]] || continue
    $managed_check "$entry" "$name" || continue
    if $remover "$versions_dir" "$name"; then
      pruned=$((pruned + 1))
    else
      echo "host component retention could not remove provider=$provider version=$name" >&2
    fi
  done < <(/usr/bin/find "$versions_dir" -mindepth 1 -maxdepth 1 -print | /usr/bin/sort)
  local retained_rollback=none
  [[ -z "$rollback_release_dir" ]] || retained_rollback="$previous_version"
  echo "host component retention provider=$provider pruned=${pruned} retained_current=${current_version} retained_rollback=${retained_rollback}"
}

remove_runtime_child_directory() {
  run_as_runtime /usr/bin/rm -rf -- "$1/$2"
}

