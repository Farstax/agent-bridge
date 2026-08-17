#!/usr/bin/env node
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { AdvisorBroker } from "../src/advisorBroker.js";
import { parseAdvisorConfig } from "../src/advisorConfig.js";
import { runCli } from "../src/cli.js";
import { openDb } from "../src/db.js";

const execFileAsync = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHAIN = "claude:claude-opus-5,codex:gpt-5.6-sol";
const FORBIDDEN_ENV_KEY = /^(?:AGENT_BRIDGE_ADVISOR_|BRIDGE_ADVISOR_|TELEGRAM_.*(?:TOKEN|SECRET)|(?:AGENT_)?BRIDGE_.*(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|CREDENTIAL))/i;

export interface AdvisorFallbackSmokeResult {
  logicalCalls: number;
  attempts: Array<Record<string, unknown>>;
  selectedProvider: string;
  selectedModel: string;
  advisorChild: boolean;
  codexArgs: string[];
  forbiddenEnvKeys: string[];
  repoClean: boolean;
  canaryUnchanged: boolean;
}

interface SmokeOptions {
  isolated: boolean;
  codexCommand: string;
  inheritedEnv?: NodeJS.ProcessEnv;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function runGit(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function assertIsolated(dbPath: string, repoPath: string): void {
  const productionDb = process.env.DB_PATH ? resolve(process.env.DB_PATH) : null;
  const productionRepo = resolve(process.cwd());
  if ((productionDb && resolve(dbPath) === productionDb)
    || resolve(repoPath) === productionRepo
    || resolve(repoPath).startsWith(`${productionRepo}${sep}`)) {
    throw new Error("Refusing advisor fallback smoke against a production database or repository");
  }
}

function writeCodexWrapper(path: string, realCodex: string, capturePath: string): void {
  writeFileSync(path, [
    "#!/usr/bin/env node",
    'const { spawnSync } = require("node:child_process");',
    'const { writeFileSync } = require("node:fs");',
    "const raw = process.argv.slice(2);",
    "const args = raw.filter((value, index) => value === 'exec' || value.startsWith('-') || raw[index - 1] === '--disable');",
    `writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ args, envKeys: Object.keys(process.env).sort() }));`,
    `const child = spawnSync(${JSON.stringify(realCodex)}, raw, { stdio: "inherit", env: process.env });`,
    "if (child.error) throw child.error;",
    "process.exit(child.status ?? 1);",
  ].join("\n"));
  chmodSync(path, 0o700);
}

export async function runIsolatedAdvisorFallbackSmoke(options: SmokeOptions): Promise<AdvisorFallbackSmokeResult> {
  if (!options.isolated) throw new Error("Advisor fallback smoke requires --isolated");
  if (!options.codexCommand) throw new Error("A Codex command is required");

  const dir = mkdtempSync(join(tmpdir(), "agent-bridge-advisor-fallback-"));
  const dbPath = join(dir, "bridge.sqlite");
  const repoPath = join(dir, "repo");
  const canaryPath = join(repoPath, "CANARY");
  const capturePath = join(dir, "codex-capture.json");
  const wrapperPath = join(dir, "codex-smoke-wrapper");
  let broker: AdvisorBroker | null = null;
  let db: ReturnType<typeof openDb> | null = null;
  try {
    spawnSync("mkdir", [repoPath]);
    writeFileSync(canaryPath, "advisor-smoke-canary\n");
    runGit(repoPath, ["init", "--quiet"]);
    runGit(repoPath, ["config", "user.email", "advisor-smoke@example.invalid"]);
    runGit(repoPath, ["config", "user.name", "Advisor Smoke"]);
    runGit(repoPath, ["add", "CANARY"]);
    runGit(repoPath, ["commit", "--quiet", "-m", "canary"]);
    assertIsolated(dbPath, repoPath);
    const canaryBefore = sha256(canaryPath);
    const headBefore = runGit(repoPath, ["rev-parse", "HEAD"]);
    const realCodex = options.codexCommand.includes("/") || options.codexCommand.includes("\\")
      ? resolve(options.codexCommand)
      : options.codexCommand;
    writeCodexWrapper(wrapperPath, realCodex, capturePath);

    db = openDb(dbPath);
    let advisorChild = false;
    const inheritedEnv = options.inheritedEnv ?? process.env;
    broker = new AdvisorBroker({
      db,
      config: parseAdvisorConfig({
        BRIDGE_ADVISOR_ENABLED: "true",
        BRIDGE_ADVISOR_MODE: "manual",
        BRIDGE_ADVISOR_CHAIN: CHAIN,
        BRIDGE_ADVISOR_MAX_CALLS_PER_TURN: "1",
        BRIDGE_ADVISOR_MAX_CALLS_PER_TASK: "2",
      }),
      bots: {
        claude: { command: "claude", modelPreference: [] },
        codex: { command: wrapperPath, modelPreference: [] },
      },
      runCli: async (command, args, cwd, cliOptions) => {
        if (command === "claude") throw new Error("Claude rate limit exceeded (api_error_status: 429)");
        advisorChild = cliOptions.advisorChild === true;
        return runCli(command, args, cwd, { ...cliOptions, contextEnv: inheritedEnv });
      },
    });
    await broker.start();
    const turnKey = `isolated-turn-${Date.now()}`;
    const capability = broker.issue({
      chatKey: "isolated-advisor-smoke",
      cliKind: "codex",
      turnKey,
      taskKey: turnKey,
      repoPath,
      activeModel: "gpt-5.6-sol",
    });
    const helper = join(ROOT, "bin", "agent-bridge-advisor");
    await execFileAsync(helper, [
      "--mode", "review",
      "--task", "Validate isolated advisor fallback safety without modifying files.",
    ], {
      cwd: repoPath,
      env: {
        HOME: process.env.HOME,
        NODE_ENV: process.env.NODE_ENV,
        PATH: process.env.PATH,
        AGENT_BRIDGE_ADVISOR_CAPABILITY: capability,
      },
    });

    const call = db.raw.prepare("SELECT * FROM advisor_calls").get() as Record<string, unknown>;
    const attempts = db.raw.prepare("SELECT * FROM advisor_attempts ORDER BY ordinal").all() as Array<Record<string, unknown>>;
    const capture = JSON.parse(readFileSync(capturePath, "utf8")) as { args: string[]; envKeys: string[] };
    const logicalCalls = (db.raw.prepare("SELECT COUNT(*) AS n FROM advisor_calls").get() as { n: number }).n;
    return {
      logicalCalls,
      attempts,
      selectedProvider: String(call.selected_provider ?? ""),
      selectedModel: String(call.selected_model ?? ""),
      advisorChild,
      codexArgs: capture.args,
      forbiddenEnvKeys: capture.envKeys.filter((key) => FORBIDDEN_ENV_KEY.test(key)),
      repoClean: runGit(repoPath, ["status", "--porcelain"]) === "" && runGit(repoPath, ["rev-parse", "HEAD"]) === headBefore,
      canaryUnchanged: sha256(canaryPath) === canaryBefore,
    };
  } finally {
    if (broker) await broker.close();
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const isolated = process.argv.slice(2).includes("--isolated");
  const codexCommand = process.env.CODEX_COMMAND || "codex";
  const result = await runIsolatedAdvisorFallbackSmoke({ isolated, codexCommand });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`advisor-fallback-smoke: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
