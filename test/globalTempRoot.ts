import { chmodSync, lstatSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Every suite run writes its fixtures under one run-owned temporary root, so
// fixtures that individual tests do not remove cannot accumulate across runs.
// The prefix stays short because fixtures bind Unix sockets (108-byte limit).
// Interrupted runs leave a single agent-bridge-* directory that
// scripts/reap-tmp-artifacts.sh removes after its normal age threshold
// (read-only trees through its existing administrative fallback).
// Immutable-release fixtures leave read-only directories; restore owner write
// access (without following symlinks) so the whole root can be removed.
function makeRemovable(dir: string): void {
  try {
    chmodSync(dir, 0o700);
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (lstatSync(path).isDirectory()) makeRemovable(path);
    }
  } catch {
    // Not ours to change; rmSync below reports what it cannot remove.
  }
}

export default function setup(): () => void {
  const previous = process.env.TMPDIR;
  const root = mkdtempSync(join(tmpdir(), "agent-bridge-"));
  process.env.TMPDIR = root;
  return () => {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    makeRemovable(root);
    rmSync(root, { recursive: true, force: true });
  };
}
