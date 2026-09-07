import { accessSync, chmodSync, constants, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertRootOwnedDirectoryChain,
  inspectVoiceRuntimeLayout,
} from "../src/voiceRuntimeLayout.js";

const roots: string[] = [];

function fixture() {
  const parent = mkdtempSync(join(tmpdir(), "agent-bridge-voice-layout-"));
  roots.push(parent);
  const root = join(parent, "voice-stt");
  const component = join(root, "components", "b4938");
  mkdirSync(join(component, "bin"), { recursive: true, mode: 0o755 });
  mkdirSync(join(root, "models"), { mode: 0o755 });
  symlinkSync("components/b4938", join(root, "current"));
  return { root, component };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("voice runtime managed layout", () => {
  it("accepts a non-writable directory chain with a managed relative current pointer", () => {
    const { root, component } = fixture();

    expect(inspectVoiceRuntimeLayout(root, {
      expectedUid: process.getuid?.() ?? 0,
      minimumPath: root,
    })).toEqual({
      root,
      components: join(root, "components"),
      models: join(root, "models"),
      current: join(root, "current"),
      componentRoot: component,
    });
  });

  it("rejects a writable managed ancestor", () => {
    const { root } = fixture();
    chmodSync(join(root, "components"), 0o775);

    expect(() => inspectVoiceRuntimeLayout(root, {
      expectedUid: process.getuid?.() ?? 0,
      minimumPath: root,
    })).toThrow(/ownership or mode is unsafe/);
  });

  it("rejects a symlink in a managed executable directory chain", () => {
    const { component } = fixture();
    const realBin = join(component, "bin");
    const linkedBin = join(component, "linked-bin");
    symlinkSync(realBin, linkedBin);

    expect(() => assertRootOwnedDirectoryChain(linkedBin, {
      expectedUid: process.getuid?.() ?? 0,
      minimumPath: component,
    })).toThrow(/must not be a symlink/);
  });

  it("lets the runtime identity traverse isolated STT ancestors while a protected sibling stays closed", () => {
    const parent = mkdtempSync(join(tmpdir(), "agent-bridge-voice-boundary-"));
    roots.push(parent);
    const protectedRoot = join(parent, "var-lib-agent-bridge");
    const isolatedRoot = join(parent, "voice-stt");
    mkdirSync(join(protectedRoot, "stt", "components", "b4938"), { recursive: true, mode: 0o755 });
    mkdirSync(join(isolatedRoot, "components", "b4938", "bin"), { recursive: true, mode: 0o755 });
    mkdirSync(join(isolatedRoot, "models"), { mode: 0o755 });
    symlinkSync("components/b4938", join(isolatedRoot, "current"));
    chmodSync(protectedRoot, 0o000);

    expect(() => accessSync(protectedRoot, constants.R_OK | constants.X_OK)).toThrow();
    expect(() => accessSync(join(protectedRoot, "stt"), constants.X_OK)).toThrow();
    expect(inspectVoiceRuntimeLayout(isolatedRoot, {
      expectedUid: process.getuid?.() ?? 0,
      minimumPath: isolatedRoot,
    }).componentRoot).toBe(join(isolatedRoot, "components", "b4938"));

    chmodSync(protectedRoot, 0o700);
  });
});
