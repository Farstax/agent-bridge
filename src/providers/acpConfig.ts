import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Resolve the active Agent Bridge release root used by bundled ACP agents. */
export function resolveBridgeProjectDir(
  env: Record<string, string | undefined> = process.env,
): string {
  const configured = env.BRIDGE_CURRENT_RELEASE_DIR?.trim();
  if (configured) return configured;
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}
