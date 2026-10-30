import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import * as acp from "@agentclientprotocol/sdk";
import { openDb, type BridgeDb } from "../src/db.js";
import { effortSettingKey } from "../src/effort.js";
import { clearAcpSessionConfigSnapshot, replaceAcpSessionConfigSnapshot } from "../src/acp/sessionConfig.js";
import { OutwardAcpSessionRepository } from "../src/repositories/outwardAcpSessionRepository.js";
import { createOutwardAcpAgent, WORKSTREAM_METHODS, type OutwardAcpSessionStore } from "../src/acpServer/app.js";
import { AcpCommands } from "../src/acpServer/commands.js";
import { BridgeOutwardAcpPromptExecutor, OUTWARD_ACP_SURFACE } from "../src/acpServer/execution.js";
import type { BotKind, BridgeConfig } from "../src/types.js";

const roots: string[] = [];
const dbs: BridgeDb[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const config = {
  allowedUserIds: new Set<string>(),
  serviceEnvFile: null,
  serviceKind: "codex",
  pollIntervalMs: 1000,
  executionMode: "safe",
  dbPath: ":memory:",
  bots: {
    codex: { command: "codex", modelPreference: [], token: "" },
    claude: { command: "claude", modelPreference: [], token: "" },
  },
} as unknown as BridgeConfig;

function setup(options: { chain?: BotKind[]; btw?: boolean; gate?: Promise<void>; available?: BotKind[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "agent-bridge-acp-commands-"));
  roots.push(root);
  const db = openDb(join(root, "bridge.sqlite"), { databaseRole: "interactive" });
  dbs.push(db);
  const repo = new OutwardAcpSessionRepository(db.raw);
  repo.create({ sessionId: "s1", conversationId: "acp:c1", cwd: root });
  const sessions: OutwardAcpSessionStore = {
    create: (s) => repo.create(s),
    get: (id) => repo.get(id),
    list: (cwd, o) => repo.list(cwd, o),
    update: (id, c) => repo.update(id, c),
  };
  const prompts: string[] = [];
  const attachmentPaths: string[][] = [];
  const attachmentContents: string[][] = [];
  const attachmentRunIds: Array<string | undefined> = [];
  const btwCalls: Array<[BotKind, string]> = [];
  let n = 0;
  const exec = new BridgeOutwardAcpPromptExecutor({
    db,
    providerChain: options.chain ?? ["codex", "claude"],
    isProviderAvailable: (provider) => options.available?.includes(provider) ?? true,
    runId: () => `run-${++n}`,
    btw: options.btw === false ? undefined : async (_s, provider, prompt) => {
      btwCalls.push([provider, prompt]);
      return `side answer: ${prompt}`;
    },
    createEngine: (_s, provider) => ({
      executeSurfaceNeutralTurn: async (input) => {
        prompts.push(input.prompt);
        attachmentPaths.push(input.attachments ?? []);
        attachmentContents.push((input.attachments ?? []).map((path) => readFileSync(path, "utf8")));
        attachmentRunIds.push(input.runId);
        if (options.gate) await options.gate;
        return { text: `answer from ${provider}`, sessionId: `${provider}-session`, stopReason: "end_turn" };
      },
    }),
  });
  const commands = new AcpCommands({ db, config, control: exec, codexUsage: async () => "Codex usage: 12%" });
  const app = createOutwardAcpAgent({ sessions, promptExecutor: exec, workstreams: exec, commands, workspaceRoot: root });
  const run = <T = { command: string; text: string; options?: Array<{ label: string; selected: boolean; token: string }> }>(
    params: Record<string, unknown>,
  ) => acp.client({ name: "generic" }).connectWith(app, (agent) =>
    agent.request<T>(WORKSTREAM_METHODS.runCommand, { sessionId: "s1", cwd: root, ...params }));
  const list = () => acp.client({ name: "generic" }).connectWith(app, (agent) =>
    agent.request<{ commands: Array<{ name: string; available: boolean; reason?: string; route: string }> }>(
      WORKSTREAM_METHODS.commands, { sessionId: "s1", cwd: root }));
  return { root, db, repo, exec, app, run, list, prompts, btwCalls, attachmentPaths, attachmentContents, attachmentRunIds };
}

describe("outward ACP commands", () => {
  it("publishes a provider-aware catalogue with explicit disabled reasons", async () => {
    const { list, run, exec, repo } = setup();
    const byName = (await list()).commands;
    const names = byName.map((c) => c.name);
    for (const name of ["start", "reset", "models", "effort", "queue_mode", "skills", "usage", "narration", "context", "btw", "stop", "cli", "switch", "sensors", "autonomy", "help", "new", "status"]) {
      expect(names).toContain(name);
    }
    const get = (name: string) => byName.find((c) => c.name === name)!;
    expect(get("usage")).toMatchObject({ available: true });
    expect(get("narration")).toMatchObject({ available: false, reason: "only available on Antigravity" });
    expect(get("queue_mode").available).toBe(false);
    expect(get("sensors").available).toBe(false);
    expect(get("autonomy").available).toBe(false);
    expect(get("stop").route).toBe("session/cancel");
    expect(get("new").description).toBe("Create a session");
    expect((await run({ command: "new" })).text).toBe("Create a new session with session/new.");

    exec.selectProvider(repo.get("s1")!, "claude");
    const claude = (await list()).commands;
    expect(claude.find((c) => c.name === "usage")).toMatchObject({ available: false, reason: "only available on Codex" });
  });

  it("advertises command controls only when their owners are wired", async () => {
    const { app } = setup();
    const initialized = await acp.client({ name: "generic" }).connectWith(app, (agent) =>
      agent.request(acp.methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} }));
    expect(initialized.agentCapabilities?._meta).toEqual({ "agent-bridge": { workstreams: 1, commands: 1 } });
  });

  it("keeps recovery and provider-switch commands available when the selected provider is unavailable", async () => {
    const { list } = setup({ available: ["claude"] });
    const byName = (await list()).commands;
    expect(byName.find((c) => c.name === "models")).toMatchObject({ available: false, reason: "codex is not installed or authenticated" });
    expect(byName.find((c) => c.name === "cli")?.available).toBe(true);
    expect(byName.find((c) => c.name === "reset")?.available).toBe(true);
  });

  it("runs read-only owners and fails closed for unavailable or unknown commands", async () => {
    const { run } = setup();
    expect((await run({ command: "context" })).text).toContain("Context status");
    expect((await run({ command: "/start" })).text).toContain("bridge ready");
    expect((await run({ command: "usage" })).text).toBe("Codex usage: 12%");
    await expect(run({ command: "narration" })).rejects.toMatchObject({ code: -32602 });
    await expect(run({ command: "autonomy" })).rejects.toMatchObject({ code: -32602 });
    await expect(run({ command: "nonsense" })).rejects.toMatchObject({ code: -32602 });
    await expect(run({ command: "context", select: "x" })).rejects.toMatchObject({ code: -32602 });
  });

  it("forwards literal slash text without resetting history or cancelling an active Run", async () => {
    const { app, prompts, db } = setup();
    db.addConvTurn("acp:c1", "user", "existing history", "codex", { surfaceIdentity: OUTWARD_ACP_SURFACE });
    const texts = ["/status", "/reset", "/stop", "/models", "/STOP", "/cli claude", "/btw hi"];
    for (const text of texts) {
      await acp.client({ name: "generic" }).connectWith(app, (agent) =>
        agent.request(acp.methods.agent.session.prompt, { sessionId: "s1", prompt: [{ type: "text", text }] }));
    }
    expect(prompts).toEqual(texts);
    expect(db.getRecentConvTurns("acp:c1", 30, undefined, OUTWARD_ACP_SURFACE).map((turn) => turn.text))
      .toEqual(["existing history", ...texts.flatMap((text) => [text, "answer from codex"])]);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const active = setup({ gate });
    const pending = acp.client({ name: "generic" }).connectWith(active.app, (agent) =>
      agent.request(acp.methods.agent.session.prompt, { sessionId: "s1", prompt: [{ type: "text", text: "long" }] }));
    for (let i = 0; i < 50 && !active.prompts.length; i++) await new Promise((resolve) => setTimeout(resolve, 2));
    expect(active.exec.status(active.repo.get("s1")!).state).toBe("running");
    await expect(acp.client({ name: "generic" }).connectWith(active.app, (agent) =>
      agent.request(acp.methods.agent.session.prompt, { sessionId: "s1", prompt: [{ type: "text", text: "/stop" }] })))
      .rejects.toMatchObject({ code: -32002 });
    expect(active.exec.status(active.repo.get("s1")!).state).toBe("running");
    release();
    expect((await pending).stopReason).toBe("end_turn");
  });

  it("ingests ACP resource and image blocks for the Run and removes task files after completion", async () => {
    const { root, app, attachmentPaths, attachmentContents, attachmentRunIds, prompts } = setup();
    const result = await acp.client({ name: "generic" }).connectWith(app, (agent) =>
      agent.request(acp.methods.agent.session.prompt, {
        sessionId: "s1",
        prompt: [
          { type: "text", text: "Read these files" },
          { type: "resource", resource: { uri: "file:///input/report.csv", mimeType: "text/csv", text: "name\nAda\n" } },
          { type: "image", uri: "file:///input/chart.png", mimeType: "image/png", data: Buffer.from("png fixture").toString("base64") },
        ],
      }));
    expect(result.stopReason).toBe("end_turn");
    const paths = attachmentPaths[0]!;
    expect(paths).toHaveLength(2);
    expect(paths.every((path) => path.startsWith(root))).toBe(true);
    expect(attachmentContents[0]).toEqual(["name\nAda\n", "png fixture"]);
    expect(attachmentRunIds[0]).toMatch(/^[a-f0-9-]{36}$/);
    expect(prompts[0]).toContain("[Attached file: 01-report.csv]");
    expect(prompts[0]).toContain("[Attached file: 02-chart.png]");
    expect(paths.every((path) => !existsSync(path))).toBe(true);
  });

  it("stages embedded attachments inside a nested authorized Workstream directory", async () => {
    const { root, repo, app, attachmentPaths } = setup();
    const nested = join(root, "nested-workstream");
    mkdirSync(nested);
    repo.create({ sessionId: "nested", conversationId: "acp:nested", cwd: nested });
    await acp.client({ name: "generic" }).connectWith(app, (agent) =>
      agent.request(acp.methods.agent.session.prompt, {
        sessionId: "nested",
        prompt: [{ type: "resource", resource: { uri: "file:///input/notes.txt", mimeType: "text/plain", text: "nested content" } }],
      }));
    const stagedPath = attachmentPaths[0]![0]!;
    expect(stagedPath.startsWith(join(nested, ".agent-bridge-attachments-"))).toBe(true);
    expect(existsSync(stagedPath)).toBe(false);
  });

  it("removes staged files when the Workstream Run is cancelled", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { app, run, attachmentPaths } = setup({ gate });
    const done = acp.client({ name: "generic" }).connectWith(app, (agent) =>
      agent.request(acp.methods.agent.session.prompt, {
        sessionId: "s1",
        prompt: [{ type: "resource", resource: { uri: "file:///input/notes.md", mimeType: "text/markdown", text: "cancel me" } }],
      }));
    for (let i = 0; i < 50 && !attachmentPaths[0]; i++) await new Promise((resolve) => setTimeout(resolve, 2));
    const paths = attachmentPaths[0]!;
    expect(paths).toHaveLength(1);
    const stopping = run({ command: "stop" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    await stopping;
    expect((await done).stopReason).toBe("cancelled");
    expect(paths.every((path) => !existsSync(path))).toBe(true);
  });

  it("requires confirmation for /reset and clears history under the lane", async () => {
    const { run, app, db } = setup();
    await acp.client({ name: "t" }).connectWith(app, (agent) =>
      agent.request(acp.methods.agent.session.prompt, { sessionId: "s1", prompt: [{ type: "text", text: "hello" }] }));
    expect(db.getConvStatus("acp:c1", OUTWARD_ACP_SURFACE).turnCount).toBe(2);
    await expect(run({ command: "reset" })).rejects.toMatchObject({ code: -32602 });
    expect(db.getConvStatus("acp:c1", OUTWARD_ACP_SURFACE).turnCount).toBe(2);
    expect((await run({ command: "reset", confirm: true })).text).toContain("session reset");
    expect(db.getConvStatus("acp:c1", OUTWARD_ACP_SURFACE).turnCount).toBe(0);
  });

  it("switches provider through /cli options and rejects tokens that were not offered", async () => {
    const { run, exec, repo } = setup();
    const view = await run({ command: "cli" });
    expect(view.options).toEqual([
      { label: "codex", selected: true, token: "provider:codex" },
      { label: "claude", selected: false, token: "provider:claude" },
    ]);
    const switched = await run({ command: "switch", select: "provider:claude" });
    expect(switched.options?.find((o) => o.selected)?.label).toBe("claude");
    expect(exec.status(repo.get("s1")!).selectedProvider).toBe("claude");
    await expect(run({ command: "cli", select: "provider:grok" })).rejects.toMatchObject({ code: -32602 });
  });

  it("rejects model and effort mutations during an active Run but permits read-only catalogues", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { run, app, exec, repo, db, prompts } = setup({ gate });
    replaceAcpSessionConfigSnapshot("codex", [{
      id: "reasoning_effort",
      name: "Reasoning",
      category: "thought_level",
      type: "select",
      currentValue: "medium",
      options: [{ value: "medium", name: "Medium" }, { value: "high", name: "High" }],
    }]);
    onTestFinished(() => clearAcpSessionConfigSnapshot("codex"));
    db.setSetting("codex", "previous-model");

    const modelChoice = (await run({ command: "models" })).options![0]!.token;
    const effortChoice = (await run({ command: "effort" })).options!
      .find((option) => !option.selected && option.token.split(":").length === 3)!.token;
    const pending = acp.client({ name: "generic" }).connectWith(app, (agent) =>
      agent.request(acp.methods.agent.session.prompt, {
        sessionId: "s1", prompt: [{ type: "text", text: "long task" }],
      }));
    for (let i = 0; i < 50 && !prompts.length; i++) await new Promise((resolve) => setTimeout(resolve, 2));
    expect(exec.status(repo.get("s1")!).state).toBe("running");
    try {
      expect((await run({ command: "models" })).options?.length).toBeGreaterThan(0);
      expect((await run({ command: "effort" })).options?.length).toBeGreaterThan(0);
      await expect(run({ command: "models", select: modelChoice })).rejects.toMatchObject({ code: -32002 });
      await expect(run({ command: "effort", select: effortChoice })).rejects.toMatchObject({ code: -32002 });
      expect(db.getSetting("codex")).toBe("previous-model");
      expect(db.getSetting(effortSettingKey("codex"))).toBeNull();
    } finally {
      release();
    }
    expect((await pending).stopReason).toBe("end_turn");
    await run({ command: "models", select: modelChoice });
    await run({ command: "effort", select: effortChoice });
    expect(db.getSetting("codex")).not.toBe("previous-model");
    expect(db.getSetting(effortSettingKey("codex"))).toBe("high");
  });

  it("allows narration status but fences narration changes during an active Run", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { run, app, exec, repo, db, prompts } = setup({ chain: ["antigravity"], gate });
    const key = "antigravity:narration:acp:outward:acp:c1";
    const pending = acp.client({ name: "generic" }).connectWith(app, (agent) =>
      agent.request(acp.methods.agent.session.prompt, {
        sessionId: "s1", prompt: [{ type: "text", text: "long task" }],
      }));
    for (let i = 0; i < 50 && !prompts.length; i++) await new Promise((resolve) => setTimeout(resolve, 2));
    expect(exec.status(repo.get("s1")!).state).toBe("running");
    try {
      expect((await run({ command: "narration", argument: "status" })).text).toContain("hidden");
      await expect(run({ command: "narration", argument: "on" })).rejects.toMatchObject({ code: -32002 });
      expect(db.getSetting(key)).toBeNull();
    } finally {
      release();
    }
    expect((await pending).stopReason).toBe("end_turn");
    await run({ command: "narration", argument: "on" });
    expect(db.getSetting(key)).toBe("visible");
  });

  it("sets effort only to an offered option through the existing settings owner", async () => {
    const { run, db } = setup();
    // Options come from the live provider catalogue, as on Telegram.
    replaceAcpSessionConfigSnapshot("codex", [{
      id: "reasoning_effort",
      name: "Reasoning",
      category: "thought_level",
      type: "select",
      currentValue: "medium",
      options: [{ value: "medium", name: "Medium" }, { value: "high", name: "High" }],
    }]);
    onTestFinished(() => clearAcpSessionConfigSnapshot("codex"));
    const view = await run({ command: "effort" });
    expect(view.options?.length).toBeGreaterThan(0);
    expect(JSON.stringify(view)).not.toContain("inline_keyboard");
    // A concrete level, not the "use default" option.
    const target = view.options!.find((o) => !o.selected && o.token.split(":").length === 3)!;
    await run({ command: "effort", select: target.token });
    expect(db.getSetting(effortSettingKey("codex"))).toBe("high");
    await expect(run({ command: "effort", select: "effort:codex:extreme" })).rejects.toMatchObject({ code: -32602 });
    await expect(run({ command: "effort", select: "effort:claude:high" })).rejects.toMatchObject({ code: -32602 });
  });

  it("runs /btw as an isolated side call without touching the main session", async () => {
    const { run, prompts, btwCalls, exec, repo, list } = setup();
    // Codex cannot prove tool-free isolation, exactly as on Telegram.
    expect((await list()).commands.find((c) => c.name === "btw")).toMatchObject({ available: false });
    exec.selectProvider(repo.get("s1")!, "claude");
    expect((await run({ command: "btw", argument: "what is 2+2?" })).text).toBe("side answer: what is 2+2?");
    expect(btwCalls).toEqual([["claude", "what is 2+2?"]]);
    expect(prompts).toEqual([]);
    await expect(run({ command: "btw" })).rejects.toMatchObject({ code: -32602 });

    const unwired = setup({ btw: false });
    unwired.exec.selectProvider(unwired.repo.get("s1")!, "claude");
    await expect(unwired.run({ command: "btw", argument: "x" })).rejects.toMatchObject({ code: -32602 });
  });

  it("/stop cancels the active Run through ACP cancellation", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { run, app, exec, repo, db } = setup({ gate });
    const done = acp.client({ name: "t" }).connectWith(app, (agent) =>
      agent.request(acp.methods.agent.session.prompt, { sessionId: "s1", prompt: [{ type: "text", text: "long" }] }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(exec.status(repo.get("s1")!).state).toBe("running");
    const stopping = run({ command: "stop" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    await stopping;
    expect((await done).stopReason).toBe("cancelled");
    expect(exec.status(repo.get("s1")!).state).toBe("cancelled");
    expect(db.getRecentConvTurns("acp:c1", 10, undefined, OUTWARD_ACP_SURFACE).map((turn) => turn.role)).toEqual(["user"]);
  });
});
