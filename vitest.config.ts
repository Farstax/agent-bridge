import { defineConfig } from "vitest/config";

const runningScopedCliSupervisorSuite = process.argv.some((arg) => {
  const normalized = arg.replaceAll("\\", "/");
  return normalized.endsWith("test/cliSupervisorMatrix.test.ts") || normalized.endsWith("test/cliSupervisorParity.test.ts");
});

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.agent-bridge-repo/**", "**/archive/**"],
    ...(runningScopedCliSupervisorSuite
      ? {
          pool: "forks",
          maxWorkers: 1,
          maxConcurrency: 1,
        }
      : {
          fileParallelism: true,
          maxWorkers: "75%",
          pool: "forks",
        }),
    poolOptions: {
      forks: {
        execArgv: ["--disable-warning=ExperimentalWarning"],
      },
    },
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
