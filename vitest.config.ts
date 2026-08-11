import { defineConfig } from "vitest/config";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";

export default defineConfig({
  test: {
    env: { BRIDGE_SKIP_MEMORY_IMPORT: "1" },
    setupFiles: ["./test/setupEnv.ts"],
  },
  // The default forks pool spawns one process per CPU (4 on the CI
  // runner). Each fork independently grows toward V8's ~4GB default
  // old-space ceiling; several heavy files landing in concurrent forks
  // can push aggregate memory past the runner's ceiling and OOM-crash a
  // worker mid-suite. Run fully serial: one worker at a time removes
  // concurrent-fork memory competition entirely, at the cost of longer
  // wall-clock time. NOTE: poolOptions is a top-level option in Vitest 4,
  // not nested under `test` (that nested form is silently ignored with a
  // deprecation warning, so a prior attempt at this setting never
  // actually applied).
  poolOptions: {
    forks: {
      maxForks: 1,
    },
  },
  plugins: [
    {
      name: "prefer-ts-over-js",
      enforce: "pre",
      resolveId(id, importer) {
        if (!id.endsWith(".js") || !importer) return;
        const tsPath = resolve(dirname(importer), id.replace(/\.js$/, ".ts"));
        if (existsSync(tsPath)) return tsPath;
      },
    },
  ],
});
