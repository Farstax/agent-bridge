/**
 * Existing janitor's conversation inventory. Persisted directory ownership
 * and SQLite admission are authoritative; names on disk are not.
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { BridgeDb } from "./db.js";
import { conversationDirectoryPath, conversationDirectorySettingKey } from "./conversationDirectory.js";
import { canReapConversationArtifacts } from "./idleUpgradeAdmission.js";
import { OutwardAcpSessionRepository } from "./repositories/outwardAcpSessionRepository.js";

interface OwnedDirectory {
  key: string;
  root: string;
  source: string;
  stillOwned: () => boolean;
}

function safeDirectory(path: string, device?: number): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink()
      && stat.uid === process.getuid?.() && (device === undefined || stat.dev === device)
      && realpathSync(path) === path;
  } catch { return false; }
}

function ownedDirectories(db: BridgeDb, workspaceRoot: string): OwnedDirectory[] {
  const directories = new Map<string, OwnedDirectory>();
  const sessions = new OutwardAcpSessionRepository(db.raw);
  for (const source of sessions.listWorkspaces()) {
    for (const session of sessions.list(source)) {
      if (!session.executionCwd) continue;
      const identity = { surfaceIdentity: "acp:outward", chatKey: session.conversationId };
      let expected: string;
      try { expected = conversationDirectoryPath(source, identity); } catch { continue; }
      if (session.executionCwd !== expected) continue;
      directories.set(expected, {
        key: conversationDirectorySettingKey(identity), root: expected, source,
        stillOwned: () => {
          const current = sessions.get(session.sessionId);
          return current?.executionCwd === expected && current.cwd === source
            && current.conversationId === session.conversationId && !current.archivedAt
            && conversationDirectoryPath(current.cwd, identity) === expected;
        },
      });
    }
  }
  // Messaging surfaces persist the directory under the same identity digest.
  // Reconstruct the source partition using the existing allocation function;
  // a settings value alone cannot authorize a path elsewhere on the host.
  const source = process.env.BRIDGE_PROJECT_DIR || process.env.BRIDGE_ROOT_DIR || workspaceRoot;
  let partition: string;
  try {
    partition = dirname(conversationDirectoryPath(source, { surfaceIdentity: "janitor", chatKey: "inventory" }));
  } catch { return [...directories.values()]; }
  const prefix = "conversation-directory:v1:";
  const rows = db.raw.prepare("SELECT key, value FROM settings WHERE key LIKE ?")
    .all(prefix + "%") as Array<{ key: string; value: string | null }>;
  for (const { key, value } of rows) {
    const digest = key.slice(prefix.length);
    if (!/^[0-9a-f]{64}$/.test(digest)) continue;
    const expected = join(partition, digest.slice(0, 32));
    if (value !== expected || directories.has(expected)) continue;
    directories.set(expected, {
      key, root: expected, source, stillOwned: () => db.getSetting(key) === expected
        && dirname(conversationDirectoryPath(source, { surfaceIdentity: "janitor", chatKey: "inventory" })) === partition,
    });
  }
  return [...directories.values()];
}

/** Do not traverse mounts (including same-device bind mounts) or symlinks. */
function mountpoints(): Set<string> {
  return new Set(readFileSync("/proc/self/mountinfo", "utf8").trim().split("\n").map((line) =>
    line.split(" ")[4].replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)))));
}

function discoverCheckouts(root: string): string[] {
  if (!safeDirectory(root)) return [];
  const mounts = mountpoints();
  const device = lstatSync(root).dev;
  // Reject a mounted conversation or partition, not just mounted children.
  for (let path = root; ; path = dirname(path)) {
    if (mounts.has(path)) return [];
    if (basename(path) === ".agent-bridge-conversations" || dirname(path) === path) break;
  }
  const found: string[] = [];
  const pending = [root];
  let visited = 0;
  while (pending.length > 0) {
    const directory = pending.pop()!;
    // A conversation itself is not disposable, even if an agent initializes
    // Git there. Never descend into another checkout or its dependencies.
    if (existsSync(join(directory, ".git"))) {
      if (directory !== root) found.push(directory);
      continue;
    }
    if (++visited > 512) {
      console.log("[reap-tmp-artifacts] preserving undiscovered conversation paths (inventory limit): " + root);
      break;
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const child = join(directory, entry.name);
      if (!mounts.has(child) && safeDirectory(child, device)) pending.push(child);
    }
  }
  return found;
}

function installedReleaseCommit(): string {
  try {
    const release = dirname(dirname(fileURLToPath(import.meta.url)));
    const pointer = process.env.BRIDGE_CURRENT_RELEASE_DIR;
    if (!pointer || !lstatSync(pointer).isSymbolicLink() || realpathSync(pointer) !== release) return "";
    const manifest = join(release, "manifest.json");
    const stat = lstatSync(manifest);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o222) !== 0) return "";
    const { commit } = JSON.parse(readFileSync(manifest, "utf8")) as { commit?: string };
    return typeof commit === "string" && /^[0-9a-f]{40}$/.test(commit) && basename(release) === commit ? commit : "";
  } catch { return ""; }
}

export function reapManagedConversationArtifacts(db: BridgeDb, workspaceRoot: string, dryRun: boolean): void {
  const directories = ownedDirectories(db, workspaceRoot);
  if (!directories.length) return;
  const releaseCommit = installedReleaseCommit();
  const script = fileURLToPath(new URL("../scripts/reap-tmp-artifacts.sh", import.meta.url));
  for (const directory of directories) {
    if (!db.runInImmediateTransaction(() => canReapConversationArtifacts(db.raw, directory.key))) {
      console.log("[reap-tmp-artifacts] managed conversation cleanup deferred (execution or pending work): " + directory.root);
      continue;
    }
    for (const checkout of discoverCheckouts(directory.root)) {
      // The existing SQLite write admission transaction excludes a new Run,
      // queue claim or continuation while we inspect and reclaim this exact
      // checkout. Revalidate persisted ownership under that same transaction.
      // One candidate per transaction; no persistent maintenance fence.
      const admitted = db.runInImmediateTransaction(() => {
        if (!directory.stillOwned() || !safeDirectory(directory.root)
          || !checkout.startsWith(directory.root + sep) || !safeDirectory(checkout, lstatSync(directory.root).dev)
          || !canReapConversationArtifacts(db.raw, directory.key)) return false;
        const result = spawnSync("bash", [script, "--conversation-checkout", ...(dryRun ? ["--dry-run"] : [])], {
          env: {
            ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1",
            REAP_MANAGED_ROOT: directory.root,
            REAP_MANAGED_SOURCE: directory.source,
            REAP_MANAGED_CHECKOUT: checkout,
            REAP_MANAGED_RELEASE_COMMIT: releaseCommit,
          },
          stdio: "inherit",
        });
        if (result.error) throw result.error;
        if (result.status !== 0) throw new Error("managed checkout cleanup failed: " + checkout);
        return true;
      });
      if (!admitted) console.log("[reap-tmp-artifacts] preserving (managed ownership or admission changed): " + checkout);
    }
  }
}
