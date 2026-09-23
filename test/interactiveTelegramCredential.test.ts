import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const helperPath = new URL("../scripts/load-interactive-telegram-credential.sh", import.meta.url);
const unitPath = new URL("../systemd/agent-bridge-interactive.service", import.meta.url);
const workflowPath = new URL("../.github/workflows/release-artifact.yml", import.meta.url);
const interactiveRuntimePath = new URL("../src/index-interactive.ts", import.meta.url);
const providerLockPath = new URL("../src/providerLock.ts", import.meta.url);
const credentialName = "telegram-bot-token-interactive";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "interactive-telegram-credential-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function runHelper(options: {
  credentialsDirectory?: string;
  envToken?: string;
  args?: string[];
  trace?: boolean;
}) {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH };
  if (options.credentialsDirectory !== undefined) env.CREDENTIALS_DIRECTORY = options.credentialsDirectory;
  if (options.envToken !== undefined) env.TELEGRAM_BOT_TOKEN_INTERACTIVE = options.envToken;
  const command = options.trace ? ["-x", helperPath.pathname] : [helperPath.pathname];
  return spawnSync("bash", [...command, ...(options.args ?? [])], {
    env,
    encoding: "utf8",
  });
}

function hashCommand(): string[] {
  return ["node", "-e", "process.stdout.write(require('node:crypto').createHash('sha256').update(process.env.TELEGRAM_BOT_TOKEN_INTERACTIVE ?? '').digest('hex'))"];
}

function outputContains(result: { stdout: string; stderr: string }, secret: string): boolean {
  return result.stdout.includes(secret) || result.stderr.includes(secret);
}

describe("interactive Telegram systemd credential", () => {
  it("keeps the stock interactive unit on the env-file launch path", () => {
    const unit = readFileSync(unitPath, "utf8");
    const helper = readFileSync(helperPath, "utf8");
    const workflow = readFileSync(workflowPath, "utf8");
    const runtime = readFileSync(interactiveRuntimePath, "utf8");
    const providerLock = readFileSync(providerLockPath, "utf8");

    expect(unit).toContain("EnvironmentFile=-/etc/default/agent-bridge-shared");
    expect(unit).toContain("EnvironmentFile=/etc/default/agent-bridge-release");
    expect(unit).toContain("EnvironmentFile=/etc/default/agent-bridge-interactive");
    expect(unit).toContain('[[ -L "${BRIDGE_CURRENT_RELEASE_DIR:?}" ]]');
    expect(unit).toContain('cd "${BRIDGE_CURRENT_RELEASE_DIR:?}"');
    expect(unit).toContain('export BRIDGE_PROJECT_DIR="${BRIDGE_CURRENT_RELEASE_DIR:?}"');
    expect(unit).toContain("src/index-interactive.ts");
    expect(unit).toContain("scripts/load-interactive-telegram-credential.sh");
    expect(unit).not.toContain("LoadCredential");
    expect(unit).not.toMatch(/TELEGRAM_BOT_TOKEN_INTERACTIVE=/);
    expect(helper).toContain(credentialName);
    expect(helper).not.toContain("LoadCredential");
    expect(workflow).toContain("scripts/load-interactive-telegram-credential.sh");
    expect(runtime).not.toContain("CREDENTIALS_DIRECTORY");
    expect(runtime).not.toContain(credentialName);
    expect(providerLock).not.toContain("CREDENTIALS_DIRECTORY");
    expect(providerLock).not.toContain(credentialName);
  });

  it("preserves an environment token when no credential is attached", () => {
    const token = `env-${digest("standalone").slice(0, 12)}`;
    const result = runHelper({ envToken: token, args: hashCommand() });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(digest(token));
    expect(outputContains(result, token)).toBe(false);
  });

  it("translates only the exact credential into the child environment", () => {
    const root = makeRoot();
    const credentials = join(root, "credentials");
    const defaults = join(root, "defaults");
    mkdirSync(credentials);
    mkdirSync(defaults);
    const token = `cred-${digest("attached").slice(0, 12)}`;
    const ignored = `ignored-${digest("other").slice(0, 12)}`;
    const defaultsFile = join(defaults, "agent-bridge-interactive");
    writeFileSync(defaultsFile, "TELEGRAM_BOT_TOKEN_INTERACTIVE=legacy\n");
    writeFileSync(join(credentials, "other-credential"), `${ignored}\n`);
    writeFileSync(join(credentials, credentialName), `${token}\n`);
    const before = readdirSync(root);

    const result = runHelper({
      credentialsDirectory: credentials,
      envToken: "legacy-env-token",
      args: hashCommand(),
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(digest(token));
    expect(outputContains(result, token)).toBe(false);
    expect(outputContains(result, ignored)).toBe(false);
    expect(readFileSync(defaultsFile, "utf8")).toBe("TELEGRAM_BOT_TOKEN_INTERACTIVE=legacy\n");
    expect(readFileSync(join(credentials, credentialName), "utf8")).toBe(`${token}\n`);
    expect(readdirSync(root)).toEqual(before);
  });

  it("lets an attached credential take precedence over the environment token", () => {
    const root = makeRoot();
    const credentials = join(root, "credentials");
    mkdirSync(credentials);
    const credentialToken = `preferred-${digest("preferred").slice(0, 12)}`;
    const envToken = `legacy-${digest("legacy").slice(0, 12)}`;
    writeFileSync(join(credentials, credentialName), credentialToken);

    const result = runHelper({
      credentialsDirectory: credentials,
      envToken,
      args: hashCommand(),
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(digest(credentialToken));
    expect(result.stdout).not.toBe(digest(envToken));
    expect(outputContains(result, credentialToken)).toBe(false);
    expect(outputContains(result, envToken)).toBe(false);
  });

  it("fails a present but malformed or unreadable credential without running the child", () => {
    const root = makeRoot();
    const credentials = join(root, "credentials");
    mkdirSync(credentials);
    const marker = join(root, "child-ran");
    const token = `malformed-${digest("malformed").slice(0, 12)}`;
    writeFileSync(join(credentials, credentialName), `${token}\nsecond-line\n`);

    const malformed = runHelper({
      credentialsDirectory: credentials,
      envToken: "legacy-env-token",
      args: ["node", "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`],
    });

    expect(malformed.status).toBe(78);
    expect(malformed.stderr).toMatch(/malformed/);
    expect(outputContains(malformed, token)).toBe(false);
    expect(malformed.stderr).not.toContain(credentials);
    expect(existsSync(marker)).toBe(false);
  });

  it("fails an unreadable, non-regular, or non-exact credential input", () => {
    const root = makeRoot();
    const credentials = join(root, "credentials");
    mkdirSync(credentials);
    const token = `secret-${digest("secret").slice(0, 12)}`;
    const target = join(root, "target");
    writeFileSync(target, token);
    symlinkSync(target, join(credentials, credentialName));

    const linked = runHelper({
      credentialsDirectory: credentials,
      envToken: "legacy-env-token",
      args: hashCommand(),
    });
    expect(linked.status).toBe(78);
    expect(outputContains(linked, token)).toBe(false);
    expect(linked.stderr).not.toContain(credentials);
    expect(linked.stdout).toBe("");

    rmSync(join(credentials, credentialName));
    mkdirSync(join(credentials, credentialName));
    const directory = runHelper({
      credentialsDirectory: credentials,
      envToken: "legacy-env-token",
      args: hashCommand(),
    });
    expect(directory.status).toBe(78);
    expect(directory.stdout).toBe("");

    rmSync(join(credentials, credentialName), { recursive: true });
    const credential = join(credentials, credentialName);
    writeFileSync(credential, token);
    chmodSync(credential, 0o000);
    const unreadable = runHelper({
      credentialsDirectory: credentials,
      envToken: "legacy-env-token",
      args: hashCommand(),
    });
    chmodSync(credential, 0o600);
    expect(unreadable.status).toBe(78);
    expect(outputContains(unreadable, token)).toBe(false);
    expect(unreadable.stderr).not.toContain(credentials);
    expect(unreadable.stdout).toBe("");
  });

  it("keeps the environment token when the credential directory has no interactive token", () => {
    const root = makeRoot();
    const credentials = join(root, "credentials");
    mkdirSync(credentials);
    const envToken = `env-only-${digest("env-only").slice(0, 12)}`;
    writeFileSync(join(credentials, "unrelated"), "other\n");

    const result = runHelper({
      credentialsDirectory: credentials,
      envToken,
      args: hashCommand(),
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(digest(envToken));
    expect(outputContains(result, envToken)).toBe(false);
  });

  it("executes the interactive unit through the release pointer and credential helper", () => {
    const root = makeRoot();
    const release = join(root, "release");
    const current = join(root, "current");
    const bin = join(root, "bin");
    const result = join(root, "result");
    const credentials = join(root, "credentials");
    mkdirSync(join(release, "scripts"), { recursive: true });
    mkdirSync(bin);
    mkdirSync(credentials);
    writeFileSync(join(release, "manifest.json"), "{}\n");
    const helperDest = join(release, "scripts", "load-interactive-telegram-credential.sh");
    copyFileSync(helperPath, helperDest);
    chmodSync(helperDest, 0o755);
    symlinkSync(release, current);
    const token = `unit-${digest("unit-credential").slice(0, 12)}`;
    const legacy = `legacy-${digest("unit-legacy").slice(0, 12)}`;
    writeFileSync(join(credentials, credentialName), `${token}\n`);
    const nodeBin = join(bin, "node");
    writeFileSync(nodeBin, `#!/bin/bash
hash=$(printf '%s' "\${TELEGRAM_BOT_TOKEN_INTERACTIVE-}" | sha256sum | awk '{print $1}')
printf '%s\\n' "$hash" > ${JSON.stringify(result)}
printf '%s\\n' "$@" >> ${JSON.stringify(result)}
`);
    chmodSync(nodeBin, 0o755);
    const execLine = readFileSync(unitPath, "utf8").match(/^ExecStart=(.*)$/m)?.[1];
    expect(execLine).toBeTruthy();

    const run = spawnSync(execLine!, {
      shell: true,
      env: {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        NODE_BIN: nodeBin,
        BRIDGE_CURRENT_RELEASE_DIR: current,
        CREDENTIALS_DIRECTORY: credentials,
        TELEGRAM_BOT_TOKEN_INTERACTIVE: legacy,
        HOME: root,
      },
      encoding: "utf8",
    });

    expect(run.status).toBe(0);
    expect(readFileSync(result, "utf8").trim().split("\n")).toEqual([
      digest(token),
      "./node_modules/tsx/dist/cli.mjs",
      "src/index-interactive.ts",
    ]);
    expect(outputContains(run, token)).toBe(false);
    expect(outputContains(run, legacy)).toBe(false);

    rmSync(current);
    mkdirSync(current);
    const rejected = spawnSync(execLine!, {
      shell: true,
      env: {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        NODE_BIN: nodeBin,
        BRIDGE_CURRENT_RELEASE_DIR: current,
        HOME: root,
      },
      encoding: "utf8",
    });
    expect(rejected.status).toBe(78);
    expect(rejected.stderr).toMatch(/active release pointer is not a symlink/);
  });

  it("fails a credential containing a NUL without exposing either fragment", () => {
    const root = makeRoot();
    const credentials = join(root, "credentials");
    mkdirSync(credentials);
    const marker = join(root, "child-ran");
    writeFileSync(join(credentials, credentialName), "alpha\0beta");

    const result = runHelper({
      credentialsDirectory: credentials,
      args: ["node", "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`],
    });

    expect(result.status).toBe(78);
    expect(result.stderr).toMatch(/malformed/);
    expect(outputContains(result, "alpha")).toBe(false);
    expect(outputContains(result, "beta")).toBe(false);
    expect(result.stderr).not.toContain(credentials);
    expect(existsSync(marker)).toBe(false);
  });

  it("does not trace the credential value when shell tracing is requested", () => {
    const root = makeRoot();
    const credentials = join(root, "credentials");
    mkdirSync(credentials);
    const token = `trace-${digest("trace").slice(0, 12)}`;
    writeFileSync(join(credentials, credentialName), token);

    const result = runHelper({
      credentialsDirectory: credentials,
      trace: true,
      args: ["true"],
    });

    expect(result.status).toBe(0);
    expect(outputContains(result, token)).toBe(false);
  });
});
