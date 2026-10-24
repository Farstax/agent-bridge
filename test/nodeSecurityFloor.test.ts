import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { NODE_SECURITY_FLOORS, isNodeVersionAdmitted } from "../src/setup.js";

const shellEntrypoints = ["install.sh", "upgrade.sh", "rollout-agent-bridge.sh", "rollout-bootstrap.sh"]
  .map((name) => resolve(process.cwd(), "scripts", name));
const installer = resolve(process.cwd(), "scripts/agent-bridge-install.py");

const cases: Array<[string, boolean]> = [
  ["24.22.1", true], ["v24.22.1", true], ["24.22.2", true], ["24.23.0", true],
  ["26.12.1", true], ["26.13.0", true],
  ["24.22.0", false], ["24.15.0", false], ["24.9.99", false], ["26.12.0", false],
  ["22.99.0", false], ["25.9.0", false], ["27.0.0", false], ["23.0.0", false],
  ["24.22", false], ["24.22.1-pre", false], ["", false],
];

function extractShellGuard(path: string): string {
  const source = readFileSync(path, "utf8");
  const start = source.indexOf("NODE_SECURITY_FLOORS=");
  const end = source.indexOf("\n}\n", source.indexOf("node_version_admitted() {")) + 3;
  expect(start).toBeGreaterThanOrEqual(0);
  return source.slice(start, end);
}

describe("Node.js security floor", () => {
  const expectedFloors = Object.values(NODE_SECURITY_FLOORS).map((floor) => floor.join("."));

  it("admits only patched supported lines in source setup", () => {
    for (const [version, admitted] of cases) expect(isNodeVersionAdmitted(version), version).toBe(admitted);
  });

  it.each(shellEntrypoints)("applies the same floors in %s", (path) => {
    const guard = extractShellGuard(path);
    expect(guard).toContain(`NODE_SECURITY_FLOORS="${expectedFloors.join(" ")}"`);
    const script = `${guard}\nfor v in "$@"; do if node_version_admitted "$v"; then echo 1; else echo 0; fi; done`;
    const out = execFileSync("bash", ["-c", script, "guard", ...cases.map(([version]) => version)], { encoding: "utf8" });
    expect(out.trim().split("\n")).toEqual(cases.map(([, admitted]) => (admitted ? "1" : "0")));
  });

  it.each(shellEntrypoints.filter((path) => path.includes("rollout")))("rejects a vulnerable configured binary before activation in %s", (path) => {
    const source = readFileSync(path, "utf8");
    const probe = source.indexOf(`node_version_admitted "$node_version" || die`);
    expect(probe).toBeGreaterThan(source.indexOf(`configured Node binary is missing or symlinked`));
    expect(probe).toBeLessThan(source.indexOf("run_as_runtime() {"));
  });

  it("applies the same floors in the initial installer", () => {
    const source = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("installer", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
print(json.dumps({"floors": [".".join(map(str, f)) for f in module.NODE_SECURITY_FLOORS.values()],
  "results": [module.node_version_admitted(v) for v in sys.argv[2:]]}))
`;
    const out = JSON.parse(execFileSync("python3", ["-I", "-c", source, installer, ...cases.map(([version]) => version)], { encoding: "utf8" }));
    expect(out.floors).toEqual(expectedFloors);
    expect(out.results).toEqual(cases.map(([, admitted]) => admitted));
  });

  it("pins every maintained build selector and the direct undici dependency to patched versions", () => {
    expect(readFileSync(".nvmrc", "utf8").trim()).toBe("24.22.1");
    for (const workflow of ["ci.yml", "release-artifact.yml", "resource-stress.yml", "historical-release-artifact.yml"]) {
      const text = readFileSync(resolve(".github/workflows", workflow), "utf8");
      for (const [, version] of text.matchAll(/node-version: (\S+)/g)) expect(isNodeVersionAdmitted(version), workflow).toBe(true);
    }
    const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg.dependencies.undici).toBe(lock.packages["node_modules/undici"].version);
    const [minor, patch] = lock.packages["node_modules/undici"].version.split(".").slice(1).map(Number);
    expect(lock.packages["node_modules/undici"].version.startsWith("7.")).toBe(true);
    expect(minor > 30 || (minor === 30 && patch >= 1)).toBe(true);
  });
});
