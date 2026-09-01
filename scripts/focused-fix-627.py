from pathlib import Path

script = Path("scripts/reap-tmp-artifacts.sh")
text = script.read_text()
text = text.replace(
    'DRY_RUN=0\n[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1\n',
    'DRY_RUN=0\nFAILURES=0\n[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1\n',
    1,
)
old = '''remove_entry() {
  local entry="$1" reason="$2"
  if (( DRY_RUN )); then
    log "would remove ($reason): $entry"
  else
    log "removing ($reason): $entry"
    rm -rf -- "$entry"
  fi
}
'''
new = '''remove_entry() {
  local entry="$1" reason="$2" rm_error="" sudo_error=""
  if (( DRY_RUN )); then
    log "would remove ($reason): $entry"
    return 0
  fi

  log "removing ($reason): $entry"
  if rm_error="$(rm -rf -- "$entry" 2>&1)"; then
    return 0
  fi

  # Keep privileged cleanup bounded to the exact entry that already passed
  # the janitor's path/age/ownership checks. The runtime account is required
  # by the host-administration contract to have non-interactive admin sudo.
  if command -v sudo >/dev/null 2>&1; then
    if sudo_error="$(sudo -n /usr/bin/rm -rf -- "$entry" 2>&1)"; then
      log "removed with administrative fallback: $entry"
      return 0
    fi
  fi

  [[ -n "$rm_error" ]] && printf '%s\\n' "$rm_error" >&2
  [[ -n "$sudo_error" ]] && printf '%s\\n' "$sudo_error" >&2
  log "failed to remove eligible artifact: $entry" >&2
  FAILURES=$((FAILURES + 1))
  return 0
}
'''
if old not in text:
    raise SystemExit("remove_entry block not found")
text = text.replace(old, new, 1)
if not text.endswith("exit 0\n"):
    raise SystemExit("expected final exit not found")
text = text[:-len("exit 0\n")] + '''if (( FAILURES > 0 )); then
  log "cleanup incomplete: ${FAILURES} eligible artifact(s) could not be removed" >&2
  exit 1
fi

exit 0
'''
script.write_text(text)

test = Path("test/reapTmpArtifacts.test.ts")
t = test.read_text()
t = t.replace(
    'import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";',
    'import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";',
    1,
)
marker = '  it("dry-run reports actions without deleting anything", () => {'
addition = r'''  it("uses a bounded non-interactive admin fallback when ordinary removal is denied", () => {
    const tmpRoot = makeRoot();
    const staleScratch = join(tmpRoot, "agent-bridge-root-owned-rollout");
    const fakeBin = join(tmpRoot, "bin");
    mkdirSync(staleScratch, { recursive: true });
    mkdirSync(fakeBin, { recursive: true });
    ageEntry(staleScratch, 48);

    const fakeRm = join(fakeBin, "rm");
    writeFileSync(fakeRm, "#!/usr/bin/env bash\necho 'simulated permission denied' >&2\nexit 1\n");
    chmodSync(fakeRm, 0o755);
    const fakeSudo = join(fakeBin, "sudo");
    writeFileSync(fakeSudo, "#!/usr/bin/env bash\n[[ \"$1\" == \"-n\" ]] && shift\nexec \"$@\"\n");
    chmodSync(fakeSudo, 0o755);

    const result = run({
      REAP_TMP_ROOT: tmpRoot,
      REAP_MAX_AGE_HOURS: "24",
      PATH: `${fakeBin}:${process.env.PATH}`,
    });

    expect(result.status).toBe(0);
    expect(existsSync(staleScratch)).toBe(false);
    expect(result.stdout).toContain("administrative fallback");
    expect(result.stderr).not.toContain("simulated permission denied");
  });

  it("fails cleanup when ordinary and administrative removal both fail", () => {
    const tmpRoot = makeRoot();
    const staleScratch = join(tmpRoot, "agent-bridge-unremovable-rollout");
    const fakeBin = join(tmpRoot, "bin");
    mkdirSync(staleScratch, { recursive: true });
    mkdirSync(fakeBin, { recursive: true });
    ageEntry(staleScratch, 48);

    for (const name of ["rm", "sudo"]) {
      const executable = join(fakeBin, name);
      writeFileSync(executable, `#!/usr/bin/env bash\necho '${name} denied' >&2\nexit 1\n`);
      chmodSync(executable, 0o755);
    }

    const result = run({
      REAP_TMP_ROOT: tmpRoot,
      REAP_MAX_AGE_HOURS: "24",
      PATH: `${fakeBin}:${process.env.PATH}`,
    });

    expect(result.status).toBe(1);
    expect(existsSync(staleScratch)).toBe(true);
    expect(result.stderr).toContain("cleanup incomplete");
  });

'''
if marker not in t:
    raise SystemExit("test insertion marker not found")
test.write_text(t.replace(marker, addition + marker, 1))
