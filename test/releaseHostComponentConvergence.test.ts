import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const COMMIT = "a".repeat(40);
const ACTIVATE = join(process.cwd(), "scripts", "release-activate.py");
const CANONICAL_STT_ROOT = "/opt/agent-bridge/host-components/voice-stt";

function fileEntry(path: string) {
  const bytes = readFileSync(path);
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
  };
}

function releaseFixture(options: { declared?: boolean; installer?: boolean; componentId?: string; phaseProtocol?: boolean } = {}) {
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
    writeFileSync(installer, `#!/bin/sh\nset -eu\nprintf '%s\\n' "\${AGENT_BRIDGE_STT_ROOT:-}" > "\${HOST_COMPONENT_STATE}.stt-root"\nif [ "\${AGENT_BRIDGE_HOST_COMPONENT_PHASE:-}" = commit ] && [ ! -f "$HOST_COMPONENT_STATE" ]; then exit 7; fi\nif [ -f "$HOST_COMPONENT_STATE" ]; then\n  echo host_component_status=no_op\nelse\n  : > "$HOST_COMPONENT_STATE"\n  echo host_component_status=converged\nfi\n`);
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
    manifest.host_components = [{ id: options.componentId ?? "test-component", installer: "scripts/install-test-component.sh", ...(options.phaseProtocol === false ? {} : { phase_protocol: 1 }) }];
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

function converge(root: string, current: string, state: string, extraEnv: Record<string, string> = {}) {
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
    env: { ...process.env, HOST_COMPONENT_STATE: state, ...extraEnv },
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

  it("forces the canonical STT root when converging a voice-stt release during rollback", () => {
    const fixture = releaseFixture({ componentId: "voice-stt" });
    expect(converge(fixture.root, fixture.current, fixture.state, {
      AGENT_BRIDGE_STT_ROOT: "/var/lib/agent-bridge/stt",
    })).toMatchObject({
      status: "converged",
      components: [{ id: "voice-stt", status: "converged" }],
    });
    expect(readFileSync(`${fixture.state}.stt-root`, "utf8").trim()).toBe(CANONICAL_STT_ROOT);
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

describe("prepared host-component receipts", () => {
  it("re-runs phase preparation when a matching receipt survives but its payload does not", () => {
    const fixture = releaseFixture();
    chmodSync(fixture.root, 0o755);
    const program = `
import importlib.util, json, os, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location('release_activate', sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.production_mode = lambda: True
m.validate_release_root = lambda path: path
m.validate_release = lambda *args, **kwargs: None
m.os.chown = lambda *args: None
root, release, state = map(Path, sys.argv[2:])
first = m.prepare_release_host_components(root, release, '${COMMIT}')
state.unlink()
second = m.prepare_release_host_components(root, release, '${COMMIT}')
print(json.dumps([first, second, state.exists()]))
`;
    const result = JSON.parse(execFileSync("python3", ["-c", program, ACTIVATE, fixture.root, join(fixture.root, COMMIT), fixture.state], {
      encoding: "utf8", env: { ...process.env, HOST_COMPONENT_STATE: fixture.state },
    })) as Array<{ status: string } | boolean>;
    expect(result[0]).toMatchObject({ status: "prepared" });
    expect(result[1]).toMatchObject({ status: "prepared" });
    expect(result[2]).toBe(true);
  });

  it("refuses a legacy release without an explicit phase protocol before it can be used for rollback preparation", () => {
    const fixture = releaseFixture({ phaseProtocol: false });
    chmodSync(fixture.root, 0o755);
    const program = `
import importlib.util, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location('release_activate', sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.production_mode = lambda: True
m.validate_release_root = lambda path: path
m.validate_release = lambda *args, **kwargs: None
m.prepare_release_host_components(Path(sys.argv[2]), Path(sys.argv[3]), '${COMMIT}')
`;
    expect(() => execFileSync("python3", ["-c", program, ACTIVATE, fixture.root, join(fixture.root, COMMIT)], { encoding: "utf8" })).toThrow(/does not declare phased/);
  });
});
