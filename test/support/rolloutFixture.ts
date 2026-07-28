// Shared fixture/harness support for the guarded-rollout test suites
// (test/rolloutHelper.test.ts and test/rolloutUat.test.ts, Phase 4C
// issue #135). Single source of truth so the two suites can never drift
// on what a "fixture" actually looks like.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { createLegacyFixture, ROLE_FIXTURES } from "./legacyDbFixture";

export const helperPath = fileURLToPath(new URL("../../scripts/rollout-agent-bridge.sh", import.meta.url));
export const sentinelClearPath = fileURLToPath(new URL("../../scripts/rollout-sentinel-clear.sh", import.meta.url));
export const restoreHelperPath = fileURLToPath(new URL("../../scripts/rollout-restore.py", import.meta.url));
export const migrationScript = fileURLToPath(new URL("../../scripts/rollout-db.ts", import.meta.url));
export const migrationImplScript = fileURLToPath(new URL("../../scripts/rollout-db-impl.ts", import.meta.url));
export const authorizationScript = fileURLToPath(new URL("../../scripts/rollout-authorization.py", import.meta.url));
export const acceptanceScript = fileURLToPath(new URL("../../scripts/rollout-acceptance.py", import.meta.url));
export const tsconfigFile = fileURLToPath(new URL("../../tsconfig.json", import.meta.url));
export const sourceDir = fileURLToPath(new URL("../../src", import.meta.url));
export const nodeModules = fileURLToPath(new URL("../../node_modules", import.meta.url));

export const units = [
  "agent-bridge-antigravity.service",
  "agent-bridge-claude.service",
  "agent-bridge-codex.service",
  "agent-bridge-discord-interactive.service",
  "agent-bridge-health.service",
  "agent-bridge-interactive.service",
  "agent-bridge-worker-bot.service",
];

export interface Fixture {
  root: string;
  project: string;
  /** HEAD of the fixture's "main" branch — the target commit a rollout migrates to. */
  expectedCommit: string;
  /**
   * A distinct, earlier real commit on the same branch (Phase 4C.5, issue
   * #135) — `git reset --hard` to this SHA is what "revert to previous
   * code" actually means in the rollback drills; it's never the same value
   * as expectedCommit.
   */
  previousCommit: string;
  dbPaths: string[];
  actionLog: string;
  stateFile: string;
  backupDir: string;
  logDir: string;
  lockFile: string;
  configFile: string;
  envDir: string;
  cgroupRoot: string;
}

export const roots: string[] = [];

export function cleanupRoots(): void {
  for (const root of roots.splice(0)) {
    execFileSync("chmod", ["-R", "u+w", root], { stdio: "ignore" });
    rmSync(root, { recursive: true, force: true });
  }
}

export function executable(path: string, body: string): void {
  writeFileSync(path, body, { mode: 0o755 });
  chmodSync(path, 0o755);
}

export function createLegacyDb(path: string, pending = 0): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec(`
    CREATE TABLE bridge_state (
      chat_id TEXT PRIMARY KEY,
      codex_session_id TEXT,
      gemini_session_id TEXT,
      claude_session_id TEXT,
      antigravity_session_id TEXT,
      active_execution_lock INTEGER NOT NULL DEFAULT 0,
      last_update_id INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE pending_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_key TEXT NOT NULL,
      prompt TEXT NOT NULL,
      chat_id INTEGER NOT NULL,
      thread_id INTEGER,
      chat_type TEXT NOT NULL DEFAULT 'private',
      user_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);
  for (let index = 0; index < pending; index += 1) {
    db.prepare("INSERT INTO pending_messages (chat_key, prompt, chat_id) VALUES (?, ?, ?)")
      .run(`chat-${index}`, `pending-${index}`, index + 1);
  }
  db.close();
}

export function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function metadata(path: string) {
  const stat = statSync(path);
  return { uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o777, size: stat.size, sha256: sha256(path) };
}

export function restoreArguments(source: string, backup: string, parent = statSync(dirname(source))): string[] {
  const expected = metadata(backup);
  return [
    restoreHelperPath,
    "--source", source,
    "--backup", backup,
    "--uid", String(expected.uid),
    "--gid", String(expected.gid),
    "--mode", expected.mode.toString(8),
    "--size", String(expected.size),
    "--sha256", expected.sha256,
    "--parent-device", String(parent.dev),
    "--parent-inode", String(parent.ino),
    "--parent-uid", String(parent.uid),
    "--parent-gid", String(parent.gid),
    "--parent-mode", (parent.mode & 0o7777).toString(8),
  ];
}

export function runRestore(source: string, backup: string, environment: Record<string, string> = {}, parent = statSync(dirname(source))) {
  return spawnSync("sudo", [
    "-n",
    "env",
    "AGENT_BRIDGE_RESTORE_TEST_MODE=1",
    ...Object.entries(environment).map(([key, value]) => `${key}=${value}`),
    ...restoreArguments(source, backup, parent),
  ], { encoding: "utf8" });
}

export function rewriteConfig(fixture: Fixture, transform: (lines: string[]) => string[]): void {
  const lines = readFileSync(fixture.configFile, "utf8").trimEnd().split("\n");
  writeFileSync(fixture.configFile, `${transform(lines).join("\n")}\n`, { mode: 0o600 });
}

export function writeFakeCommands(fixture: Fixture): void {
  const bin = join(fixture.root, "bin");
  mkdirSync(bin, { recursive: true });
  executable(join(bin, "release-stage"), `#!/usr/bin/env bash
set -euo pipefail
echo "release-stage:$*" >> "${fixture.actionLog}"
`);
  executable(join(bin, "rollout-restore"), `#!/usr/bin/env bash
set -euo pipefail
echo "rollout-restore:$*" >> "${fixture.actionLog}"
if [ "\${FAKE_RESTORE_FAIL:-}" = 1 ]; then
  echo "simulated descriptor-based rollback failure" >&2
  exit 1
fi
exec sudo -n env AGENT_BRIDGE_RESTORE_TEST_MODE=1 "${restoreHelperPath}" "$@"
`);
  copyFileSync(authorizationScript, join(bin, "rollout-authorization-trusted"));
  copyFileSync(acceptanceScript, join(bin, "rollout-acceptance-trusted"));
  chmodSync(join(bin, "rollout-authorization-trusted"), 0o755);
  chmodSync(join(bin, "rollout-acceptance-trusted"), 0o755);
  executable(join(bin, "release-activate"), `#!/usr/bin/env bash
set -euo pipefail
echo "release-activate:$*" >> "${fixture.actionLog}"
current=""
expected=""
validate_only=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --current) current="$2"; shift 2 ;;
    --expected-commit) expected="$2"; shift 2 ;;
    --release-root) shift 2 ;;
    --validate-only) validate_only=1; shift ;;
    *) echo "unknown release activation argument: $1" >&2; exit 2 ;;
  esac
done
if [ "$validate_only" = 1 ]; then exit 0; fi
tmp="\${current}.test-new"
rm -f -- "$tmp"
ln -s "$expected" "$tmp"
mv -Tf -- "$tmp" "$current"
if [ "\${FAKE_RECOVERY_RESTART_COUNTER_EMPTY:-}" = 1 ]; then
  : > "${fixture.root}/recovery-pointer-activated"
fi
`);
  executable(join(bin, "systemctl"), `#!/usr/bin/env bash
set -euo pipefail
echo "systemctl:$*" >> "${fixture.actionLog}"
  cmd="$1"; shift
  case "$cmd" in
  cat)
    unit="$1"
    printf '[Unit]\nDescription=%s\n[Service]\nEnvironmentFile=-%s\nEnvironmentFile=%s\nEnvironmentFile=%s\n' "$unit" "${fixture.envDir}/agent-bridge-shared" "${fixture.envDir}/agent-bridge-release" "${fixture.envDir}/\${unit%.service}"
    ;;
  stop)
    count=0
    [ ! -f "${fixture.root}/stop-count" ] || count="$(cat "${fixture.root}/stop-count")"
    count=$((count + 1))
    printf '%s\n' "$count" > "${fixture.root}/stop-count"
    if [ -n "\${FAKE_SYSTEMCTL_STOP_DELAY:-}" ]; then sleep "$FAKE_SYSTEMCTL_STOP_DELAY"; fi
    if [ "\${FAKE_FAIL_PHASE:-}" = stop ] || { [ "$count" -gt 1 ] && [ "\${FAKE_CONTAINMENT_MODE:-}" = active ]; }; then
      printf '%s\n' "\${1:-}" > "${fixture.stateFile}"
    else
      : > "${fixture.stateFile}"
    fi
    if [ "\${FAKE_CONTAINMENT_MODE:-}" = failed-empty-live-cgroup ] || {
      [ "$count" -gt 1 ] && [ "\${FAKE_CONTAINMENT_MODE:-}" = live-cgroup ];
    }; then
      printf '9876\n' > "${fixture.cgroupRoot}/agent-bridge-test/\${1:-unknown}/cgroup.procs"
    fi
    if [ "\${FAKE_CONTAINMENT_MODE:-}" = unreadable-cgroup-procs ]; then
      chmod 000 "${fixture.cgroupRoot}/agent-bridge-test/\${1:-unknown}/cgroup.procs"
    fi
    if [ "\${FAKE_CONTAINMENT_MODE:-}" = unreadable-cgroup-dir ]; then
      chmod 000 "${fixture.cgroupRoot}/agent-bridge-test/\${1:-unknown}"
    fi
    if [ "\${FAKE_CONTAINMENT_MODE:-}" = failed-empty-stop-error ] || {
      [ "$count" -gt 1 ] && [ "\${FAKE_CONTAINMENT_MODE:-}" = stop-error ];
    }; then exit 1; fi
    ;;
  start)
    if [ "\${FAKE_FAIL_RECOVERY_START:-}" = 1 ] && [ ! -e "${fixture.root}/recovery-start-failed" ]; then
      : > "${fixture.root}/recovery-start-failed"
      exit 1
    fi
    if [ "\${FAKE_FAIL_PHASE:-}" = start ]; then exit 1; fi
    printf '%s\n' "$@" > "${fixture.stateFile}"
    : > "${fixture.root}/started"
    if [ "\${FAKE_RECOVERY_JOURNAL_ERROR:-}" = 1 ] || [ "\${FAKE_RECOVERY_EXIT_DURING_SMOKE:-}" = 1 ]; then
      /usr/bin/date -u '+%Y-%m-%d %H:%M:%S UTC' > "${fixture.root}/recovery-started-at"
      : > "${fixture.root}/recovery-started"
    fi
    ;;
  is-active)
    if [ "\${1:-}" = --quiet ]; then shift; fi
    if [ "\${FAKE_RECOVERY_EXIT_DURING_SMOKE:-}" = 1 ] && [ -e "${fixture.root}/recovery-started" ]; then
      checks=0
      [ ! -f "${fixture.root}/recovery-active-checks" ] || checks="$(cat "${fixture.root}/recovery-active-checks")"
      checks=$((checks + 1))
      printf '%s\n' "$checks" > "${fixture.root}/recovery-active-checks"
      if [ "$checks" -gt 7 ]; then exit 1; fi
    fi
    grep -Fxq "\${1:-}" "${fixture.stateFile}"
    ;;
  is-failed) exit 1 ;;
  reset-failed)
    : > "${fixture.root}/restart-counters-reset"
    ;;
  show)
    unit="$1"; shift
    properties=()
    for arg in "$@"; do case "$arg" in --property=*) properties+=("\${arg#--property=}");; esac; done
    for property in "\${properties[@]}"; do
      case "$property" in
        EnvironmentFiles)
          case "\${FAKE_ENVIRONMENT_FILES_MODE:-correct}" in
            missing) printf '%s\n%s\n' "${fixture.envDir}/agent-bridge-shared (ignore_errors=yes)" "${fixture.envDir}/\${unit%.service} (ignore_errors=no)" ;;
            extra) printf '%s\n%s\n%s\n%s\n' "${fixture.envDir}/agent-bridge-shared (ignore_errors=yes)" "${fixture.envDir}/agent-bridge-release (ignore_errors=no)" "${fixture.envDir}/\${unit%.service} (ignore_errors=no)" "${fixture.envDir}/unexpected (ignore_errors=no)" ;;
            reordered) printf '%s\n%s\n%s\n' "${fixture.envDir}/\${unit%.service} (ignore_errors=no)" "${fixture.envDir}/agent-bridge-release (ignore_errors=no)" "${fixture.envDir}/agent-bridge-shared (ignore_errors=yes)" ;;
            *) printf '%s\n%s\n%s\n' "${fixture.envDir}/agent-bridge-shared (ignore_errors=yes)" "${fixture.envDir}/agent-bridge-release (ignore_errors=no)" "${fixture.envDir}/\${unit%.service} (ignore_errors=no)" ;;
          esac
          ;;
        FragmentPath) echo "${fixture.root}/systemd/\${unit}" ;;
        DropInPaths) : ;;
        Environment) echo NODE_ENV=production ;;
        ActiveState)
          if grep -Fxq "$unit" "${fixture.stateFile}"; then echo active
          elif [[ "\${FAKE_CONTAINMENT_MODE:-}" == *failed-empty* ]]; then echo failed
          else echo inactive
          fi
          ;;
        SubState) grep -Fxq "$unit" "${fixture.stateFile}" && echo running || echo dead ;;
        Result) [[ "\${FAKE_CONTAINMENT_MODE:-}" == *failed-empty* ]] && echo exit-code || echo success ;;
        ExecMainCode) [[ "\${FAKE_CONTAINMENT_MODE:-}" == *failed-empty* ]] && echo exited || echo 0 ;;
        ExecMainStatus) [[ "\${FAKE_CONTAINMENT_MODE:-}" == *failed-empty* ]] && echo 143 || echo 0 ;;
        MainPID) grep -Fxq "$unit" "${fixture.stateFile}" && echo 4242 || echo 0 ;;
        ControlPID) echo 0 ;;
        ControlGroup)
          case "\${FAKE_CONTAINMENT_MODE:-}" in
            empty-controlgroup) echo "" ;;
            missing-cgroup-dir) echo "/agent-bridge-missing/$unit" ;;
            *) echo "/agent-bridge-test/$unit" ;;
          esac
          ;;
        NRestarts)
          if [ "\${FAKE_RECOVERY_RESTART_COUNTER_EMPTY:-}" = 1 ] && [ -e "${fixture.root}/recovery-pointer-activated" ]; then :;
          elif [ "\${FAKE_RESTART_COUNTER_HISTORY:-}" ] && [ ! -f "${fixture.root}/restart-counters-reset" ]; then echo "\${FAKE_RESTART_COUNTER_HISTORY}";
          elif [ "\${FAKE_FAIL_PHASE:-}" = delayed ] && [ -f "${fixture.root}/started" ]; then echo 1; else echo 0; fi
          ;;
        *) exit 2 ;;
      esac
    done
    ;;
  *) exit 2 ;;
esac
`);
  executable(join(bin, "cp"), `#!/usr/bin/env bash
set -euo pipefail
echo "root: backup $*" >> "${fixture.actionLog}"
/usr/bin/cp "$@"
if [ "\${FAKE_FAIL_PHASE:-}" = backup ] && [ ! -e "${fixture.root}/backup-failed" ]; then
  : > "${fixture.root}/backup-failed"
  exit 70
fi
`);
  executable(join(bin, "runuser"), `#!/usr/bin/env bash
set -euo pipefail
echo "runuser:$*" >> "${fixture.actionLog}"
if [ "\${1:-}" = --user ]; then shift 2; fi
if [ "\${1:-}" = -- ]; then shift; fi
phase=""
for arg in "$@"; do case "$arg" in inspect|checkpoint|backup|migrate|validate) phase="$arg";; esac; done
if [ -n "\${FAKE_FAIL_PHASE:-}" ] && [ "\${FAKE_FAIL_PHASE:-}" = "$phase" ]; then
  "$@"
  if [ -n "\${FAKE_CORRUPT_DB:-}" ]; then printf 'corrupt' > "$FAKE_CORRUPT_DB"; fi
  exit 70
fi
exec "$@"
`);
  executable(join(bin, "journalctl"), `#!/usr/bin/env bash
set -euo pipefail
echo "journalctl:$*" >> "${fixture.actionLog}"
if [ -n "\${FAKE_TAMPER_SENTINEL_REPLACE:-}" ]; then
  # mv a freshly created, genuinely distinct-inode decoy file over the
  # sentinel path — rm-then-recreate at the same path risks the filesystem
  # reusing the just-freed inode number, which would defeat the point of
  # this test (proving an identity mismatch is detected).
  decoy="\$(mktemp)"
  printf 'tampered\\n' > "\$decoy"
  chmod 0600 "\$decoy"
  mv -f -- "\$decoy" "\${FAKE_TAMPER_SENTINEL_REPLACE}"
fi
if [ -n "\${FAKE_TAMPER_SENTINEL_DELETE:-}" ]; then
  rm -f -- "\${FAKE_TAMPER_SENTINEL_DELETE}"
fi
if [ "\${FAKE_FAIL_PHASE:-}" = smoke ]; then echo 'simulated startup error'; fi
if [ "\${FAKE_RECOVERY_JOURNAL_ERROR:-}" = 1 ] && [ -e "${fixture.root}/recovery-started" ]; then
  since=""
  previous=""
  for arg in "$@"; do
    if [ "$previous" = --since ]; then since="$arg"; fi
    previous="$arg"
  done
  recovery_started="$(cat "${fixture.root}/recovery-started-at")"
  if [ -n "$since" ] && [ "$(/usr/bin/date -u -d "$since" +%s)" -le "$(/usr/bin/date -u -d "$recovery_started" +%s)" ]; then
    echo 'simulated recovery startup error'
  fi
fi
if [ "\${FAKE_NO_JOURNAL_ENTRIES:-}" = 1 ]; then echo '-- No entries --'; fi
`);
}

export function createFixture(options: { pending?: number; unknownSchema?: boolean; missingDb?: boolean; initiallyStopped?: boolean } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "agent-bridge-rollout-"));
  roots.push(root);
  const project = join(root, "project");
  const dbDir = join(root, "databases");
  const backupDir = join(root, "backups");
  const logDir = join(root, "logs");
  const actionLog = join(root, "actions.log");
  const stateFile = join(root, "active-units");
  const lockFile = join(root, "run", "lock", "agent-bridge-rollout.lock");
  const configFile = join(root, "etc", "agent-bridge", "rollout.conf");
  const envDir = join(root, "etc", "default");
  const cgroupRoot = join(root, "sys", "fs", "cgroup");
  mkdirSync(join(project, "scripts"), { recursive: true });
  mkdirSync(join(root, "etc", "agent-bridge"), { recursive: true });
  mkdirSync(envDir, { recursive: true });
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  for (const unit of units) {
    const cgroup = join(cgroupRoot, "agent-bridge-test", unit);
    mkdirSync(cgroup, { recursive: true });
    writeFileSync(join(cgroup, "cgroup.procs"), "");
  }
  symlinkSync(sourceDir, join(project, "src"));
  symlinkSync(nodeModules, join(project, "node_modules"));
  if (existsSync(migrationScript)) copyFileSync(migrationScript, join(project, "scripts", "rollout-db.ts"));
  if (existsSync(migrationImplScript)) copyFileSync(migrationImplScript, join(project, "scripts", "rollout-db-impl.ts"));
  if (existsSync(authorizationScript)) copyFileSync(authorizationScript, join(project, "scripts", "rollout-authorization.py"));
  if (existsSync(acceptanceScript)) copyFileSync(acceptanceScript, join(project, "scripts", "rollout-acceptance.py"));
  if (existsSync(tsconfigFile)) copyFileSync(tsconfigFile, join(project, "tsconfig.json"));
  writeFileSync(join(project, "package.json"), JSON.stringify({ type: "module" }) + "\n");
  writeFileSync(join(project, "README.md"), "rollout fixture\n");
  execFileSync("git", ["init", "-q", project]);
  execFileSync("git", ["-C", project, "config", "user.email", "rollout@example.invalid"]);
  execFileSync("git", ["-C", project, "config", "user.name", "Rollout Test"]);
  execFileSync("git", ["-C", project, "add", "."]);
  execFileSync("git", ["-C", project, "commit", "-qm", "fixture (previous release)"]);
  execFileSync("git", ["-C", project, "branch", "-M", "main"]);
  const previousCommit = execFileSync("git", ["-C", project, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  // A second, genuinely distinct commit — expectedCommit is always the
  // target a rollout migrates to; previousCommit is always what "revert to
  // previous code" (§9) actually checks out. Never the same SHA, so a
  // rollback drill can't accidentally pass by comparing a value to itself.
  writeFileSync(join(project, "RELEASE_MARKER"), "target release\n");
  execFileSync("git", ["-C", project, "add", "RELEASE_MARKER"]);
  execFileSync("git", ["-C", project, "commit", "-qm", "fixture (target release)"]);
  const expectedCommit = execFileSync("git", ["-C", project, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

  const dbPaths = Array.from({ length: 5 }, (_, index) => join(dbDir, `bridge-${index}.sqlite`));
  for (const [index, path] of dbPaths.entries()) {
    if (options.unknownSchema && index === 0) {
      mkdirSync(dirname(path), { recursive: true });
      const db = new Database(path); db.exec("CREATE TABLE unknown_schema(value TEXT)"); db.close();
    } else if (!(options.missingDb && index === 0)) {
      createLegacyDb(path, index === 0 ? options.pending ?? 0 : 0);
    }
  }

  writeFileSync(join(envDir, "agent-bridge-shared"), `DB_PATH=${dbPaths[0]}\n`, { mode: 0o600 });
  writeFileSync(join(envDir, "agent-bridge-release"), "# fixture release environment\n", { mode: 0o600 });
  for (const unit of units) {
    const name = unit.replace(/\.service$/, "");
    let content = "";
    if (unit === "agent-bridge-discord-interactive.service") content = `DB_PATH=${dbPaths[1]}\n`;
    if (unit === "agent-bridge-health.service") content = `HEALTH_DB_PATH=${dbPaths[2]}\n`;
    if (unit === "agent-bridge-interactive.service") content = `DB_PATH=${dbPaths[3]}\n`;
    if (unit === "agent-bridge-worker-bot.service") content = `DB_PATH=${dbPaths[4]}\n`;
    writeFileSync(join(envDir, name), content, { mode: 0o600 });
  }

  writeFileSync(configFile, [
    `project_dir=${project}`,
    "runtime_user=rollout-test",
    "environment=production-content-crawler",
    `node_bin=${process.execPath}`,
    `backup_dir=${backupDir}`,
    `log_dir=${logDir}`,
    ...units.map((unit) => `unit=${unit}`),
    ...dbPaths.map((path) => `database=${path}`),
    "",
  ].join("\n"), { mode: 0o600 });
  writeFileSync(stateFile, options.initiallyStopped ? "" : `${units.join("\n")}\n`);
  writeFileSync(actionLog, "");
  const fixture = { root, project, expectedCommit, previousCommit, dbPaths, actionLog, stateFile, backupDir, logDir, lockFile, configFile, envDir, cgroupRoot };
  writeFakeCommands(fixture);
  return fixture;
}

export function runRollout(fixture: Fixture, failPhase?: string, containmentMode?: string, extraEnv: Record<string, string> = {}) {
  return spawnSync("bash", [helperPath, "--expected-commit", fixture.expectedCommit], {
    encoding: "utf8",
    env: {
      ...process.env,
      AGENT_BRIDGE_ROLLOUT_TEST_ROOT: fixture.root,
      ...(failPhase ? { FAKE_FAIL_PHASE: failPhase } : {}),
      ...(containmentMode ? { FAKE_CONTAINMENT_MODE: containmentMode } : {}),
      FAKE_CORRUPT_DB: fixture.dbPaths[0],
      ...extraEnv,
    },
  });
}

export function useMinimalInventory(fixture: Fixture): Fixture {
  const selectedUnit = units[0];
  rewriteConfig(fixture, (lines) => [
    ...lines.filter((line) => !line.startsWith("unit=") && !line.startsWith("database=")),
    `unit=${selectedUnit}`,
    `database=${fixture.dbPaths[0]}`,
  ]);
  writeFileSync(fixture.stateFile, `${selectedUnit}\n`);
  return fixture;
}

export function actions(fixture: Fixture): string {
  return readFileSync(fixture.actionLog, "utf8");
}

export async function waitForAction(fixture: Fixture, pattern: RegExp, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pattern.test(actions(fixture))) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${pattern}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// `systemctl --user` is one real, shared, stateful daemon per OS user —
// unlike every other fixture in this suite, tests that drive it for real
// are not mutually isolated just because each uses its own temp root.
// Concurrent real-systemd tests (across files, under vitest's default
// file-level parallelism) can race the same systemd job queue and cause
// genuine, non-deterministic failures (job cancellation, services not
// reaching "active" in time) that have nothing to do with the script
// under test. This is a real mutual-exclusion lock, not a documented
// "don't run these in parallel" convention — every real-systemd test
// must acquire it before touching systemd --user and release it after.
//
// Kernel-held (real `flock`), not an exclusive-create sentinel file: a
// crashed test runner's own process death releases the flock for free.
// An exclusive-create file would instead be left behind indefinitely,
// blocking every future run until someone notices and removes it by
// hand. The lock file itself (the inode flock operates on) is never
// deleted — only ever the process holding it is killed to release.
const REAL_SYSTEMD_LOCK_PATH = join(tmpdir(), "agent-bridge-real-systemd-uat.flock");

export async function acquireRealSystemdLock(timeoutMs = 60_000): Promise<() => void> {
  const holder = spawn("bash", [
    "-c",
    `exec 9>"${REAL_SYSTEMD_LOCK_PATH}"; flock --exclusive 9; echo LOCKED; exec sleep infinity`,
  ], { stdio: ["ignore", "pipe", "ignore"] });

  let locked = false;
  let output = "";
  holder.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
    if (output.includes("LOCKED")) locked = true;
  });

  const deadline = Date.now() + timeoutMs;
  while (!locked) {
    if (Date.now() >= deadline) {
      holder.kill("SIGKILL");
      throw new Error("timed out waiting for the real-systemd UAT lock");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return () => {
    holder.kill("SIGKILL");
  };
}

/**
 * Per-fixture unique suffix (Phase 4C.5, issue #135), deterministic from
 * the fixture's own unique temp root so every call site (the fake
 * systemctl shim, unit-file setup, teardown, assertions) derives the same
 * mapping independently without threading extra state through every
 * function signature.
 */
function uatRunId(fixture: Fixture): string {
  return createHash("sha1").update(fixture.root).digest("hex").slice(0, 12);
}

/**
 * The real, unique systemd unit name a production unit name maps to for
 * this fixture's real-systemd UAT run. `rollout-agent-bridge.sh`'s
 * compiled ALLOWED_UNITS allowlist requires the *config* to list the
 * exact production names — that allowlist is exactly what's under test
 * and must never be loosened — so the remapping happens one layer below,
 * inside the fake systemctl shim that translates each unit-name argument
 * before ever touching the real systemd --user session. Real systemd
 * therefore never manages anything named after a real Agent Bridge
 * service, regardless of what the script itself believes it's operating
 * on.
 */
export function uniqueUnitName(fixture: Fixture, productionUnit: string): string {
  return productionUnit.replace(/\.service$/, `-uat-${uatRunId(fixture)}.service`);
}

/**
 * Reseeds all five configured databases from the fixed, pre-versioned
 * PR #147 role fixtures (shared/discord/health/interactive/worker, in the
 * same order as fixture.dbPaths — see the DB_PATH wiring above), instead
 * of the generic minimal shape createFixture() uses by default. Layers a
 * legacy-shaped pending_messages table on top of the untouched upstream
 * fixture: rollout-db.ts's own inspectDatabase() REQUIRE_TABLES check
 * demands pending_messages exist even pre-migration (a stricter
 * precondition than openDb()'s own CREATE TABLE IF NOT EXISTS repair
 * path), so without this the real rollout's preflight `inspect` step
 * would reject the fixture before migration ever ran.
 */
export function seedRoleFixtures(fixture: Fixture): void {
  fixture.dbPaths.forEach((path, index) => {
    const role = ROLE_FIXTURES[index];
    if (!role) throw new Error(`no PR #147 role fixture for database index ${index}`);
    rmSync(path, { force: true });
    rmSync(`${path}-wal`, { force: true });
    rmSync(`${path}-shm`, { force: true });
    createLegacyFixture(path);
    const db = new Database(path);
    db.exec(`
      CREATE TABLE pending_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_key TEXT NOT NULL,
        prompt TEXT NOT NULL,
        chat_id INTEGER NOT NULL,
        thread_id INTEGER,
        chat_type TEXT NOT NULL DEFAULT 'private',
        user_id INTEGER,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `);
    db.close();
  });
}
