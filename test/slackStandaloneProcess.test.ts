/**
 * Standalone acceptance (#943): the real `src/index-slack-interactive.ts`
 * process, the real Slack SDK clients, a real ACP child process (the repository
 * fake agent) and a hermetic Slack stand-in speaking the wire protocol. Nothing
 * outside this repository is involved.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { FakeSlackServer, type FakeSlackOptions } from "./support/fakeSlackServer.js";

const fakeAgent = fileURLToPath(new URL("./support/fakeAcpAgent.ts", import.meta.url));
const tsxCli = join(process.cwd(), "node_modules/tsx/dist/cli.mjs");
const TOKENS = { bot: "xoxb-1111-secret-bot-token", app: "xapp-1-secret-app-token" };

let home: string;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "slack-standalone-home-"));
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "auth.json"), "{}");
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

interface Running {
  child: ChildProcess;
  dir: string;
  dbPath: string;
  statusPath: string;
  output: () => string;
  exit: Promise<number | null>;
}

function startCompanion(slackUrl: string, extraEnv: NodeJS.ProcessEnv = {}, dir = mkdtempSync(join(tmpdir(), "slack-standalone-"))): Running {
  const dbPath = join(dir, "slack.sqlite");
  const statusPath = join(dir, "status.json");
  const tokenDir = join(dir, "tokens");
  mkdirSync(tokenDir, { recursive: true });
  writeFileSync(join(tokenDir, "bot"), `${TOKENS.bot}\n`, { mode: 0o600 });
  writeFileSync(join(tokenDir, "app"), `${TOKENS.app}\n`, { mode: 0o600 });
  // The production opener never creates a database: bootstrap it exactly as documented.
  const boot = spawnSync(process.execPath, ["--import", "tsx", "scripts/rollout-db.ts", "bootstrap", "--db", dbPath, "--role", "slack", "--confirm-new-role", dbPath], {
    cwd: process.cwd(), encoding: "utf8", env: { ...process.env, HOME: home },
  });
  if (boot.status !== 0) throw new Error(`database bootstrap failed: ${boot.stdout}${boot.stderr}`);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    NODE_ENV: "test",
    BRIDGE_PROJECT_DIR: dir,
    BRIDGE_ENV_FILE: join(dir, "absent.env"),
    DB_PATH: dbPath,
    AGENT_BRIDGE_INSTALLATION_ID: "",
    SLACK_BOT_TOKEN_FILE: join(tokenDir, "bot"),
    SLACK_APP_TOKEN_FILE: join(tokenDir, "app"),
    SLACK_BOT_TOKEN: "",
    SLACK_APP_TOKEN: "",
    SLACK_ALLOWED_USER_IDS: "U0ALLOWED",
    SLACK_STATUS_FILE: statusPath,
    SLACK_API_URL: slackUrl,
    INTERACTIVE_CLI_CHAIN: "codex",
    CODEX_ACP_COMMAND: process.execPath,
    CODEX_ACP_ARGS: `${tsxCli} ${fakeAgent}`,
    FAKE_ACP_STORE: join(dir, "acp-store.json"),
    BRIDGE_EXECUTION_MODE: "safe",
    // The fake ACP agent reports a real outcome through the provider child
    // environment. This proves the standalone surface remains compatible
    // with mandatory ordinary-Run outcome reporting.
    FAKE_ACP_REPORT_OUTCOME: "1",
    ...extraEnv,
  };
  const child = spawn(process.execPath, ["--import", "tsx", "src/index-slack-interactive.ts"], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout?.setEncoding("utf8").on("data", (c: string) => { out += c; });
  child.stderr?.setEncoding("utf8").on("data", (c: string) => { out += c; });
  const exit = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  return { child, dir, dbPath, statusPath, output: () => out, exit };
}

const status = (running: Running) => (existsSync(running.statusPath) ? JSON.parse(readFileSync(running.statusPath, "utf8")) : null);
const dm = (text: string, extra: Record<string, unknown> = {}) => ({ type: "message", channel_type: "im", channel: "D0DM", user: "U0ALLOWED", text, ts: "1800000100.000100", ...extra });

async function waitUntil(condition: () => boolean, label: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("standalone Slack companion over the wire (#943)", () => {
  const cleanup: Array<() => Promise<void> | void> = [];
  afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

  async function boot(options: FakeSlackOptions = {}, env: NodeJS.ProcessEnv = {}) {
    const slack = new FakeSlackServer(options);
    const url = await slack.start();
    const running = startCompanion(url, env);
    cleanup.push(async () => {
      if (running.child.exitCode === null) { running.child.kill("SIGTERM"); await Promise.race([running.exit, new Promise((r) => setTimeout(r, 3000))]); }
      if (running.child.exitCode === null) running.child.kill("SIGKILL");
      await slack.stop();
      rmSync(running.dir, { recursive: true, force: true });
    });
    return { slack, running };
  }
  const receipts = (running: Running) => {
    const db = new Database(running.dbPath, { readonly: true });
    try { return db.prepare("SELECT idempotency_key, status, run_id, payload_json FROM event_receipts WHERE source = 'slack' ORDER BY id").all() as any[]; }
    finally { db.close(); }
  };
  const runOutcomes = (running: Running) => {
    const db = new Database(running.dbPath, { readonly: true });
    try { return db.prepare("SELECT outcome_status, outcome_detail FROM bridge_runs ORDER BY started_at").all() as Array<{ outcome_status: string | null; outcome_detail: string | null }>; }
    finally { db.close(); }
  };

  it("binds identity on the live socket, acknowledges after the receipt, runs once and replies in the DM", async () => {
    const { slack, running } = await boot();
    await waitUntil(() => status(running)?.state === "connected", "connected status");
    expect(status(running)).toMatchObject({ schemaVersion: 1, appId: "A0APP", teamId: "T0TEAM", botUserId: "U0BOT", errorCode: null, pid: running.child.pid });
    expect(slack.apiCalls).toEqual(expect.arrayContaining(["auth.test", "bots.info", "users.info", "apps.connections.open"]));

    const envelope = slack.push(dm("marker-DM-1"), { eventId: "EvDM1" });
    await slack.waitFor(() => slack.posted.some((p) => p.text.includes("marker-DM-1")), 20_000, "DM reply");
    expect(slack.acks).toContain(envelope);
    const reply = slack.posted.find((p) => p.text.includes("marker-DM-1"))!;
    expect(reply.channel).toBe("D0DM");
    expect(reply.thread_ts).toBeUndefined();
    await waitUntil(() => receipts(running).some((r) => r.status === "completed"), "completed receipt");
    const [row] = receipts(running);
    expect(row).toMatchObject({ idempotency_key: "slack:T0TEAM:A0APP:EvDM1", status: "completed" });
    expect(row.run_id).toBeTruthy();
    expect(row.payload_json).toBe("{}");
    expect(runOutcomes(running)).toContainEqual({ outcome_status: "complete", outcome_detail: "fixture reply verified" });
    // Secrets never reach logs or the status file.
    expect(running.output()).not.toContain(TOKENS.bot);
    expect(running.output()).not.toContain(TOKENS.app);
    expect(JSON.stringify(status(running))).not.toMatch(/xox|marker-DM/);
  }, 90_000);

  it("replies to a channel mention in a new thread and keeps a mentioned thread reply in that thread", async () => {
    const { slack, running } = await boot();
    await waitUntil(() => status(running)?.state === "connected", "connected status");
    slack.push({ type: "app_mention", channel: "C0CHAN", user: "U0ALLOWED", text: "<@U0BOT> marker-thread-root", ts: "1800000200.000100" }, { eventId: "EvM1" });
    await slack.waitFor(() => slack.posted.some((p) => p.text.includes("marker-thread-root")), 20_000, "mention reply");
    const first = slack.posted.find((p) => p.text.includes("marker-thread-root"))!;
    expect(first).toMatchObject({ channel: "C0CHAN", thread_ts: "1800000200.000100" });
    slack.push({ type: "app_mention", channel: "C0CHAN", user: "U0ALLOWED", text: "<@U0BOT> marker-thread-follow", ts: "1800000210.000200", thread_ts: "1800000200.000100" }, { eventId: "EvM2" });
    await slack.waitFor(() => slack.posted.some((p) => p.text.includes("marker-thread-follow")), 20_000, "thread reply");
    const second = slack.posted.find((p) => p.text.includes("marker-thread-follow"))!;
    expect(second).toMatchObject({ channel: "C0CHAN", thread_ts: "1800000200.000100" });
    for (const post of slack.posted) expect(post.channel).not.toContain(":");
  }, 120_000);

  it("acknowledges but never re-executes a redelivered event and ignores unauthorized and foreign traffic", async () => {
    const { slack, running } = await boot();
    await waitUntil(() => status(running)?.state === "connected", "connected status");
    slack.push(dm("marker-dup"), { eventId: "EvDup" });
    await slack.waitFor(() => slack.posted.some((p) => p.text.includes("marker-dup")), 20_000, "first reply");
    const before = slack.posted.filter((p) => p.text.includes("marker-dup")).length;
    const acksBefore = slack.acks.length;
    slack.push(dm("marker-dup"), { eventId: "EvDup" });
    slack.push(dm("marker-intruder", { user: "U0OTHER", ts: "1800000300.000100" }), { eventId: "EvBad1" });
    slack.push(dm("marker-foreign", { ts: "1800000301.000100" }), { eventId: "EvBad2", appId: "A0OTHER" });
    await slack.waitFor(() => slack.acks.length >= acksBefore + 3, 15_000, "acknowledgements");
    await new Promise((r) => setTimeout(r, 1500));
    expect(slack.posted.filter((p) => p.text.includes("marker-dup"))).toHaveLength(before);
    expect(slack.posted.some((p) => p.text.includes("marker-intruder") || p.text.includes("marker-foreign"))).toBe(false);
    expect(receipts(running).filter((r) => r.idempotency_key.endsWith("EvDup"))).toHaveLength(1);
  }, 90_000);

  it("re-proves the app on reconnect and keeps serving events", async () => {
    const { slack, running } = await boot();
    await waitUntil(() => status(running)?.state === "connected", "connected status");
    const connections = slack.connectionCount;
    slack.dropConnections();
    await waitUntil(() => slack.connectionCount > connections && slack.connected, "reconnected socket", 30_000);
    await waitUntil(() => status(running)?.state === "connected", "connected again");
    slack.push(dm("marker-after-reconnect", { ts: "1800000400.000100" }), { eventId: "EvRe" });
    await slack.waitFor(() => slack.posted.some((p) => p.text.includes("marker-after-reconnect")), 20_000, "reply after reconnect");
  }, 120_000);

  it("refuses an app-level token that belongs to another app: failed status, exit 78, nothing served", async () => {
    const { slack, running } = await boot({ helloAppId: "A0INTRUDER" });
    const code = await Promise.race([running.exit, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 30_000))]);
    expect(code).toBe(78);
    expect(status(running)).toMatchObject({ state: "failed", errorCode: "app_mismatch" });
    expect(slack.posted).toHaveLength(0);
    expect(running.output()).not.toContain(TOKENS.app);
  }, 60_000);

  it("fails closed on a missing allowlist and on rotating tokens without contacting Slack", async () => {
    const slack = new FakeSlackServer();
    const url = await slack.start();
    cleanup.push(() => slack.stop());
    const noAllowlist = startCompanion(url, { SLACK_ALLOWED_USER_IDS: "" });
    cleanup.push(() => rmSync(noAllowlist.dir, { recursive: true, force: true }));
    expect(await noAllowlist.exit).toBe(78);
    expect(noAllowlist.output()).toContain("default deny");
    const rotating = startCompanion(url, { SLACK_BOT_TOKEN_FILE: "", SLACK_BOT_TOKEN: "xoxe.xoxb-1-rotating" });
    cleanup.push(() => rmSync(rotating.dir, { recursive: true, force: true }));
    expect(await rotating.exit).toBe(78);
    expect(slack.apiCalls).toEqual([]);
  }, 60_000);
});
