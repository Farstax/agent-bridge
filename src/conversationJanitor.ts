/**
 * Existing janitor's conversation inventory. Persisted directory ownership
 * and SQLite admission are authoritative; names on disk are not.
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
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

function ownedDirectories(db: BridgeDb, workspaceRoot: string, includeArchived = false): OwnedDirectory[] {
  const directories = new Map<string, OwnedDirectory>();
  const sessions = new OutwardAcpSessionRepository(db.raw);
  for (const source of sessions.listWorkspaces()) {
    for (const session of sessions.list(source, { includeArchived })) {
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

function discoverCheckouts(root: string, strict = false): string[] {
  if (!safeDirectory(root)) {
    if (strict) throw new Error("unsafe conversation inventory root: " + root);
    return [];
  }
  const mounts = mountpoints();
  const device = lstatSync(root).dev;
  // Reject a mounted conversation or partition, not just mounted children.
  for (let path = root; ; path = dirname(path)) {
    if (mounts.has(path)) {
      if (strict) throw new Error("mounted conversation inventory root: " + root);
      return [];
    }
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
    if (++visited > 512) throw new Error("conversation checkout inventory limit: " + root);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const child = join(directory, entry.name);
      if (!mounts.has(child) && safeDirectory(child, device)) pending.push(child);
      else if (strict) throw new Error("unverified conversation inventory child: " + child);
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


const fullSha = /^[0-9a-f]{40}$/;
const gitEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1",
  GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/bin/false", SSH_ASKPASS: "/bin/false" };
function gitRead(cwd: string, args: string[], input?: string): string | undefined {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    input, encoding: "utf8", env: gitEnv, timeout: 5000, maxBuffer: 1024 * 1024,
    stdio: ["pipe", "pipe", "ignore"],
  });
  return result.status === 0 ? result.stdout.trim() : undefined;
}
function githubSlug(origin: string): string | undefined {
  return /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(origin)?.[1].toLowerCase();
}
type Proof = { tip: string; origin: string; defaultBranch: string };

/** Use public read access first, then the existing repository-scoped Git
 * credential protocol. Secrets travel over stdin, never argv or logs. */
function githubReader(source: string, slug: string) {
  let auth: string | undefined;
  let triedCredentials = false;
  function request(path: string, token?: string): unknown {
    const result = spawnSync("curl", ["--disable", "--proto", "=https", "--max-time", "5",
      "--max-filesize", "1048576", "--silent", "--fail", "--header", "Accept: application/vnd.github+json",
      "--config", "-", "https://api.github.com/repos/" + slug + path], {
      input: token ? "header = " + JSON.stringify("Authorization: Bearer " + token) + "\n" : "",
      encoding: "utf8", timeout: 6000, maxBuffer: 1024 * 1024, stdio: ["pipe", "pipe", "ignore"],
    });
    if (result.status !== 0) return undefined;
    try { return JSON.parse(result.stdout); } catch { return undefined; }
  }
  return (path: string): unknown => {
    const result = request(path, auth);
    if (result !== undefined || triedCredentials) return result;
    triedCredentials = true;
    const credential = gitRead(source, ["-c", "credential.useHttpPath=true", "-c", "credential.interactive=false", "credential", "fill"],
      "protocol=https\nhost=github.com\npath=" + slug + ".git\n\n");
    const token = credential?.split("\n").find(line => line.startsWith("password="))?.slice(9);
    if (!token || !/^[A-Za-z0-9_.-]+$/.test(token)) return undefined;
    auth = token;
    return request(path, auth);
  };
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function proveIntegration(source: string, checkout: string, releaseCommit: string): Proof | undefined {
  const origin = gitRead(checkout, ["remote", "get-url", "origin"]);
  const tip = gitRead(checkout, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (!origin || !tip || !fullSha.test(tip)) return undefined;
  const configured = gitRead(source, ["remote", "get-url", "origin"]);
  const slug = githubSlug(origin);
  const trusted = [configured, process.env.REAP_OSS_ORIGIN].some(expected =>
    !!expected && (expected === origin || (!!slug && githubSlug(expected) === slug)));
  if (!trusted) {
    // An immutable release is evidence for its own history only, not authority
    // to query an arbitrary candidate-declared repository.
    if (fullSha.test(releaseCommit) && gitRead(checkout, ["merge-base", "--is-ancestor", tip, releaseCommit]) !== undefined)
      return { tip, origin, defaultBranch: "main" };
    return undefined;
  }
  if (!slug) {
    // Non-GitHub upstream: pin the actual remote HEAD without changing refs.
    const remote = gitRead(source, ["ls-remote", "--symref", origin, "HEAD"]);
    const branch = /^ref: refs\/heads\/([^\t\n]+)\tHEAD$/m.exec(remote ?? "")?.[1];
    const base = /^([0-9a-f]{40})\tHEAD$/m.exec(remote ?? "")?.[1];
    return branch && base && gitRead(checkout, ["merge-base", "--is-ancestor", tip, base]) !== undefined
      ? { tip, origin, defaultBranch: branch } : undefined;
  }
  const get = githubReader(source, slug);
  const repo = record(get(""));
  const branch = repo.default_branch;
  if (typeof repo.full_name !== "string" || repo.full_name.toLowerCase() !== slug
    || typeof branch !== "string" || !branch || branch.length > 255) return undefined;
  const base = record(record(get("/branches/" + encodeURIComponent(branch))).commit).sha;
  if (typeof base !== "string" || !fullSha.test(base)) return undefined;
  function integrated(sha: string): boolean {
    if (sha === base || gitRead(checkout, ["merge-base", "--is-ancestor", sha, base]) !== undefined) return true;
    const comparison = record(get("/compare/" + sha + "..." + base));
    return (comparison.status === "ahead" || comparison.status === "identical")
      && record(comparison.merge_base_commit).sha === sha;
  }
  if (integrated(tip)) return { tip, origin, defaultBranch: branch };
  const pulls = get("/commits/" + tip + "/pulls?per_page=100");
  if (!Array.isArray(pulls)) return undefined;
  for (const candidate of pulls) {
    const pr = record(candidate), target = record(pr.base), merged = pr.merge_commit_sha;
    if (record(pr.head).sha !== tip || typeof pr.merged_at !== "string" || !Number.isFinite(Date.parse(pr.merged_at))
      || target.ref !== branch || String(record(target.repo).full_name).toLowerCase() !== slug
      || typeof merged !== "string" || !fullSha.test(merged)) continue;
    if (integrated(merged)) return { tip, origin, defaultBranch: branch };
  }
  return undefined;
}

/** Protect incoming dependency links from every discovered checkout, not
 * just the candidate's own conversation. Include unowned sibling directories
 * for observation only, and registered worktrees of known repositories. */
function sharedDependencyTarget(directories: OwnedDirectory[], candidate: string): boolean {
  try {
    const checkouts = new Set<string>();
    for (const partition of new Set(directories.map(d => dirname(d.root)))) {
      if (!existsSync(partition)) continue;
      if (!safeDirectory(partition)) return true;
      for (const entry of readdirSync(partition, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const root = join(partition, entry.name);
        if (!safeDirectory(root)) return true;
        for (const checkout of discoverCheckouts(root, true)) checkouts.add(checkout);
        if (existsSync(join(root, ".git"))) checkouts.add(root);
      }
    }
    for (const { source } of directories) {
      const root = gitRead(source, ["rev-parse", "--show-toplevel"]);
      if (root) checkouts.add(root);
    }
    for (const checkout of checkouts) {
      const list = gitRead(checkout, ["worktree", "list", "--porcelain", "-z"]);
      if (!list) return true;
      for (const line of list.split("\0")) {
        if (!line.startsWith("worktree ")) continue;
        const registered = line.slice(9);
        try {
          if (!lstatSync(registered).isDirectory() || realpathSync(registered) !== registered) return true;
          checkouts.add(registered);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true;
        }
      }
      if (checkouts.size > 512) return true;
    }
    for (const checkout of checkouts) {
      if (checkout === candidate) continue;
      let path = join(checkout, "node_modules");
      const seen = new Set<string>();
      for (;;) {
        let stat;
        try { stat = lstatSync(path); } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
          return true;
        }
        if (!stat.isSymbolicLink()) break;
        if (seen.has(path) || seen.size >= 32) return true;
        seen.add(path);
        path = resolve(dirname(path), readlinkSync(path));
        if (path === candidate || path.startsWith(candidate + sep)) return true;
        // Resolve symlinked path components and dangling final targets too.
        const resolved = spawnSync("realpath", ["-m", "--", path], { encoding: "utf8", timeout: 1000 });
        if (resolved.status !== 0) return true;
        const target = resolved.stdout.trim();
        if (target === candidate || target.startsWith(candidate + sep)) return true;
      }
    }
    return false;
  } catch { return true; }
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
      // Network evidence is read outside the write transaction. Pin the exact
      // tip/origin and verify them again before any filesystem mutation.
      const proof = proveIntegration(directory.source, checkout, releaseCommit);
      if (!proof) {
        console.log("[reap-tmp-artifacts] preserving (unverified upstream integration): " + checkout);
        continue;
      }
      // The existing SQLite write admission transaction excludes a new Run,
      // queue claim or continuation while we inspect and reclaim this exact
      // checkout. Revalidate persisted ownership under that same transaction.
      // One candidate per transaction; no persistent maintenance fence.
      const started = Date.now();
      const admitted = db.runInImmediateTransaction(() => {
        if (!directory.stillOwned() || !safeDirectory(directory.root)
          || !checkout.startsWith(directory.root + sep) || !safeDirectory(checkout, lstatSync(directory.root).dev)
          || !canReapConversationArtifacts(db.raw, directory.key)) return false;
        if (sharedDependencyTarget(ownedDirectories(db, workspaceRoot, true), checkout)) {
          console.log("[reap-tmp-artifacts] preserving (shared dependency target or unverified link inventory): " + checkout);
          return true;
        }
        const result = spawnSync("bash", [script, "--conversation-checkout", ...(dryRun ? ["--dry-run"] : [])], {
          env: {
            ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1",
            REAP_MANAGED_ROOT: directory.root,
            REAP_MANAGED_SOURCE: directory.source,
            REAP_MANAGED_CHECKOUT: checkout,
            REAP_MANAGED_PROVEN_TIP: proof.tip,
            REAP_MANAGED_PROVEN_ORIGIN: proof.origin,
            REAP_MANAGED_DEFAULT_BRANCH: proof.defaultBranch,
          },
          stdio: "inherit",
        });
        if (result.error) throw result.error;
        if (result.status !== 0) throw new Error("managed checkout cleanup failed: " + checkout);
        return true;
      });
      console.log("[reap-tmp-artifacts] managed cleanup transaction ms=" + (Date.now() - started));
      if (!admitted) console.log("[reap-tmp-artifacts] preserving (managed ownership or admission changed): " + checkout);
    }
  }
}
