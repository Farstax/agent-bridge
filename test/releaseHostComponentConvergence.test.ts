import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const COMMIT = "a".repeat(40);
const ACTIVATE = join(process.cwd(), "scripts", "release-activate.py");

function fileEntry(path: string) {
  const bytes = readFileSync(path);
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
  };
}

function releaseFixture(options: { declared?: boolean; installer?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "agent-bridge-host-components-"));
  const release = join(root, COMMIT);
  const scripts = join(release, "scripts");
  const current = join(root, "current");
  const state = join(root, "component-state");
  mkdirSync(scripts, { recursive: true });

  const rolloutDb = join(scripts, "rollout-db.ts");
  const rolloutImpl = join(scripts, "rollout-db-impl.ts");
  const installer = join(scripts, "install-test-component.sh");
  writeFileSync(rolloutDb, "export {};\n");
  writeFileSync(rolloutImpl, "export {};\n");
  if (options.installer !== false) {
    writeFileSync(installer, `#!/bin/sh\nset -eu\nif [ -f "$HOST_COMPONENT_STATE" ]; then\n  echo host_component_status=no_op\nelse\n  : > "$HOST_COMPONENT_STATE"\n  echo host_component_status=converged\nfi\n`);
  }

  const files = [
    { path: "scripts/rollout-db.ts", ...fileEntry(rolloutDb) },
    { path: "scripts/rollout-db-impl.ts", ...fileEntry(rolloutImpl) },
  ];
  if (options.installer !== false) {
    files.push({ path: "scripts/install-test-component.sh", ...fileEntry(installer) });
  } else if (options.declared !== false) {
    files.push({ path: "scripts/install-test-component.sh", sha256: "0".repeat(64), size: 0 });
  }

  const manifest: Record<string, unknown> = {
    schema_version: 1,
    commit: COMMIT,
    build_strategy: "compiled",
    files,
  };
  if (options.declared !== false) {
    manifest.host_components = [{ id: "test-component", installer: "scripts/install-test-component.sh" }];
  }
  const manifestPath = join(release, "manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);

  for (const path of [rolloutDb, rolloutImpl, manifestPath]) chmodSync(path, 0o444);
  if (options.installer !== false) chmodSync(installer, 0o444);
  chmodSync(scripts, 0o555);
  chmodSync(release, 0o555);
  symlinkSync(COMMIT, current);
  return { root, current, state };
}

function converge(root: string, current: string, state: string) {
  const program = `
import importlib.util, json, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location("release_activate", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
production_calls = iter((False, True))
module.production_mode = lambda: next(production_calls)
result = module.converge_active_release_host_components(Path(sys.argv[2]), Path(sys.argv[3]))
print(json.dumps(result, sort_keys=True))
`;
  const output = execFileSync("python3", ["-c", program, ACTIVATE, root, current], {
    encoding: "utf8",
    env: { ...process.env, HOST_COMPONENT_STATE: state },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(output.trim()) as { status: string; release: string; components: Array<{ id: string; status: string }> };
}

describe("active release host-component convergence", () => {
  it("repairs once, preserves the active release pointer, then becomes a component no-op", () => {
    const fixture = releaseFixture();
    const before = readlinkSync(fixture.current);

    expect(converge(fixture.root, fixture.current, fixture.state)).toEqual({
      schema_version: 1,
      release: COMMIT,
      status: "converged",
      components: [{ id: "test-component", status: "converged" }],
    });
    expect(readlinkSync(fixture.current)).toBe(before);
    expect(statSync(fixture.state).isFile()).toBe(true);

    expect(converge(fixture.root, fixture.current, fixture.state)).toEqual({
      schema_version: 1,
      release: COMMIT,
      status: "no_op",
      components: [{ id: "test-component", status: "no_op" }],
    });
    expect(readlinkSync(fixture.current)).toBe(before);
  });

  it("fails strict active-release validation when a declared installer is missing", () => {
    const fixture = releaseFixture({ installer: false });
    const before = readlinkSync(fixture.current);
    expect(() => converge(fixture.root, fixture.current, fixture.state)).toThrow();
    expect(readlinkSync(fixture.current)).toBe(before);
  });

  it("keeps a genuine undeclared historical release valid without fabricating a component", () => {
    const fixture = releaseFixture({ declared: false, installer: false });
    expect(converge(fixture.root, fixture.current, fixture.state)).toEqual({
      schema_version: 1,
      release: COMMIT,
      status: "no_op",
      components: [],
    });
  });
});
