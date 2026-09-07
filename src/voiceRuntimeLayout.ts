import { accessSync, constants, lstatSync, readlinkSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export const DEFAULT_VOICE_STT_ROOT = "/opt/agent-bridge/host-components/voice-stt";

interface DirectoryChainOptions {
  expectedUid?: number;
  minimumPath?: string;
}

export interface VoiceRuntimeLayout {
  root: string;
  components: string;
  models: string;
  current: string;
  componentRoot: string;
}

function insideOrEqual(parent: string, child: string): boolean {
  const value = relative(resolve(parent), resolve(child));
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

export function assertRootOwnedDirectoryChain(
  path: string,
  { expectedUid = 0, minimumPath = "/" }: DirectoryChainOptions = {},
): void {
  const leaf = resolve(path);
  const minimum = resolve(minimumPath);
  if (leaf !== path || minimum !== minimumPath || !insideOrEqual(minimum, leaf)) {
    throw new Error(`managed voice directory path is not canonical: ${path}`);
  }

  const chain: string[] = [];
  for (let current = leaf;; current = dirname(current)) {
    chain.push(current);
    if (current === minimum) break;
  }
  for (const directory of chain.reverse()) {
    const info = lstatSync(directory);
    if (info.isSymbolicLink()) throw new Error(`managed voice directory must not be a symlink: ${directory}`);
    if (!info.isDirectory()) throw new Error(`managed voice directory is unavailable: ${directory}`);
    if (info.uid !== expectedUid || (info.mode & 0o022) !== 0) {
      throw new Error(`managed voice directory ownership or mode is unsafe: ${directory}`);
    }
    accessSync(directory, constants.X_OK);
  }
}

export function inspectVoiceRuntimeLayout(
  root: string = DEFAULT_VOICE_STT_ROOT,
  options: DirectoryChainOptions = {},
): VoiceRuntimeLayout {
  assertRootOwnedDirectoryChain(root, options);
  const components = join(root, "components");
  const models = join(root, "models");
  assertRootOwnedDirectoryChain(components, { ...options, minimumPath: root });
  assertRootOwnedDirectoryChain(models, { ...options, minimumPath: root });

  const current = join(root, "current");
  const currentInfo = lstatSync(current);
  const expectedUid = options.expectedUid ?? 0;
  if (!currentInfo.isSymbolicLink() || currentInfo.uid !== expectedUid) {
    throw new Error("managed voice current pointer is unsafe");
  }
  const target = readlinkSync(current);
  if (!target.startsWith("components/") || target.includes("..") || isAbsolute(target)) {
    throw new Error("managed voice current pointer target is unsafe");
  }
  const componentRoot = resolve(root, target);
  if (!insideOrEqual(components, componentRoot) || componentRoot === components) {
    throw new Error("managed voice component escaped the component root");
  }
  assertRootOwnedDirectoryChain(componentRoot, { ...options, minimumPath: components });
  return { root, components, models, current, componentRoot };
}
