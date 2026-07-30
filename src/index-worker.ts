/**
 * PURPOSE: Entry point for the autonomous worker bot.
 * Handles /jobs, /issues, /review, /chain commands. Routes plain messages
 * to the active CLI engine via a fallback chain (codex → claude → antigravity).
 * When a CLI is at capacity, the chain advances and retries with the next CLI,
 * injecting the last 3 turns as context.
 * NEIGHBORS: src/workerBot.ts, src/engine.ts, src/workerFallback.ts, src/workerDispatch.ts
 */

import dotenv from "dotenv";
import {
  getBridgeProjectDir,
  isAuthorizedMessage,
} from "./bridge.js";
import { openProductionDb } from "./db.js";
import { loadBotsConfig, loadRoleAssignmentConfig, resolveBusyMessageMode, validateBusyMessageModeEnv } from "./config.js";
import { TelegramClient } from "./telegram.js";
import { BridgeEngine } from "./engine.js";
import { sendTelegramMessage } from "./messageDelivery.js";
import { handleWorkerCommand, handleWorkerConversationText, isWorkerCommand, buildWorkerCommands } from "./workerBot.js";
import { WorkerFallbackChain } from "./workerFallback.js";
import { runCliWithFallback } from "./workerDispatch.js";
import { handleWorkerCallback } from "./workCallbacks.js";
import {
  dispatchInteractiveWithFallback,
  dispatchClaimedInteractiveWithFallback,
  getUserCliPreference,
  setUserCliPreference,
  handleCliSwitchCallback,
  buildInteractiveCommands,
  isCliCommandText,
  buildCliStatusText,
  buildCliKeyboard,
  applyManualCliSwitchHandoff,
  resolveUpdateChatKey,
  type CliKind,
} from "./interactiveBot.js";
import { parseCompactionProviderChain, runCapacityFallbackCompaction } from "./fallbackCompaction.js";
import { startJobExecutorLoop } from "./jobExecutorLoop.js";
import { createDefectScanHandler } from "./handlers/defectScan.js";
import { createFeaturePlanHandler } from "./handlers/featurePlan.js";
import { createGithubIssueHandler } from "./handlers/githubIssue.js";
import { createTddImplementationHandler } from "./handlers/tddImplementation.js";
import { createOrchestratedTaskHandler } from "./handlers/orchestratedTask.js";
import { createPrLifecycleHandler } from "./handlers/prLifecycle.js";
import { createPrWatchHandler } from "./handlers/prWatch.js";
import { createPrRefreshHandler } from "./handlers/prRefresh.js";
import { createRefactorScanHandler } from "./handlers/refactorScan.js";
import { createImplementationPlanHandler } from "./handlers/implementationPlan.js";
import { captureFeatureBrief, hasPendingCustomRepo, clearPendingCustomRepo } from "./featureBriefCapture.js";
import { runCli } from "./cli.js";
import { createRunCommand } from "./runCommandAsync.js";
import { prepareWorkspace, createWorkspaceCleanup, resolveLocalRepoPath } from "./workspace.js";
import { resolveWorkerCliPolicy } from "./workerCliPolicy.js";
import { workerEffortForTask } from "./effort.js";
import { sendApprovalHtmlPack } from "./approvalHtml.js";
import type { BridgeConfig, BotKind, TelegramUpdate } from "./types.js";
import { parseAdvisorConfig } from "./advisorConfig.js";
import { startConfiguredAdvisorBroker } from "./advisorBroker.js";
import { AdvisorService } from "./advisorService.js";
import { getExecutionProcessState } from "./cliSupervisor.js";

dotenv.config({
  path: process.env.BRIDGE_ENV_FILE || ".env.worker",
  override: false,
});


const token = process.env.TELEGRAM_BOT_TOKEN_WORKER;
if (!token) throw new Error("TELEGRAM_BOT_TOKEN_WORKER is required");

const allowedUserIds = new Set(
  (process.env.TELEGRAM_ALLOWED_USER_IDS || process.env.TELEGRAM_ALLOWED_USER_ID || "")
    .split(",").map(s => s.trim()).filter(Boolean)
);

const workerEnabled = process.env.WORKER_ENABLED === "true";
const jobPollIntervalMs = Number(process.env.WORKER_JOB_POLL_INTERVAL_MS || 10_000);
const prWatchIntervalMs = Number(process.env.WORKER_PR_WATCH_INTERVAL || 3_600_000); // 1h default
const prStaleHours = Number(process.env.WORKER_PR_STALE_HOURS || 72);
const workerCliPolicy = resolveWorkerCliPolicy(process.env);
const cliChain = workerCliPolicy.interactiveChain;
const codeCliChain = workerCliPolicy.codeChain;
const scribeCliChain = workerCliPolicy.scribeChain;
const codeCommand = process.env.WORKER_CODE_CLI_COMMAND || codeCliChain[0];
const scribeCommand = process.env.WORKER_SCRIBE_CLI_COMMAND || process.env.DEFECT_SCAN_CLI_COMMAND || scribeCliChain[0];
const dbPath = process.env.DB_PATH || `${getBridgeProjectDir()}/.data/bridge.sqlite`;
const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS || 1000);
const executionMode = (process.env.BRIDGE_EXECUTION_MODE as "safe" | "trusted") || "safe";
validateBusyMessageModeEnv(process.env);
const busyMessageMode = resolveBusyMessageMode(process.env);
const asyncEnabled = process.env.BRIDGE_ASYNC_ENABLED !== "false";
const advisorConfig = parseAdvisorConfig(process.env);
// Parse fail-closed before opening the database so malformed or secret-bearing
// desired policy cannot cause startup maintenance or persistence side effects.
const roleAssignmentConfig = loadRoleAssignmentConfig(process.env);
const roleScopeKey = roleAssignmentConfig?.scopeKey
  ?? process.env.WORKER_ROLE_ASSIGNMENT_SCOPE?.trim()
  ?? "worker:default";

const db = openProductionDb(dbPath, {
  serviceId: "telegram:worker",
  installationId: process.env.AGENT_BRIDGE_INSTALLATION_ID,
  requireInstallationIdentity: process.env.NODE_ENV === "production" && Boolean(process.env.AGENT_BRIDGE_INSTALLATION_ID?.trim()),
  databaseRole: "worker",
});
await db.reconcileOrphanedRuns({
  minAgeMs: Number(process.env.ORPHAN_RECONCILIATION_MIN_AGE_MS || 60_000),
  processState: (run) => getExecutionProcessState(run.run_id),
  containmentState: (_run, state) => state === "absent" ? "proven" : "ambiguous",
  onReconciled: (run) => console.warn(`[worker-bot] reconciled orphaned run ${run.run_id}`),
});
const roleAssignmentRevision = roleAssignmentConfig
  ? db.createRoleAssignmentRevision(roleAssignmentConfig)
  : db.getCurrentRoleAssignmentRevision(roleScopeKey);
const client = new TelegramClient(token, fetch, 45_000);

function withThread<T extends Record<string, unknown>>(body: T, threadId?: number): T & { message_thread_id?: number } {
  return threadId != null ? { ...body, message_thread_id: threadId } : body;
}

// ── Fallback chain state (shared across all dispatches) ───────────────────────

const fallbackChain = new WorkerFallbackChain(cliChain, db);
const compactionProviderChain = parseCompactionProviderChain(process.env.BRIDGE_COMPACTION_CHAIN);
const exhaustedChats = new Set<string>();

// ── Bridge config ─────────────────────────────────────────────────────────────

const config: BridgeConfig = {
  allowedUserIds,
  serviceEnvFile: process.env.BRIDGE_ENV_FILE || null,
  serviceKind: null,
  pollIntervalMs,
  executionMode,
  busyMessageMode,
  asyncEnabled,
  dbPath,
  bots: loadBotsConfig(process.env),
};
const agentAdvisorBroker = await startConfiguredAdvisorBroker({ db, bots: config.bots, runCli });

// ── Build one engine per CLI kind ─────────────────────────────────────────────

const CLI_KINDS = ["codex", "claude", "antigravity"] as const;
const engines = Object.fromEntries(
  CLI_KINDS.map((kind) => {
    const botConfig = config.bots[kind as BotKind];
    return [
      kind,
      new BridgeEngine(
        {
          kind,
          surfaceIdentity: "telegram:worker",
          botConfig: { ...botConfig, token },
          allowedUserIds,
          executionMode,
          busyMessageMode,
          asyncEnabled,
          pollIntervalMs,
          fullConfig: config,
          advisorCapabilities: agentAdvisorBroker ?? undefined,
          hooks: {
            onCapacityExhausted: async (chatKey: string) => {
              exhaustedChats.add(chatKey);
            },
          },
        },
        db,
        client,
      ),
    ];
  }),
) as Record<string, BridgeEngine>;

for (const engine of Object.values(engines)) {
  engine.setQueuedMessageHandler(async (queued) => {
    return dispatchClaimedInteractiveWithFallback(queued, queued.chatKey, {
      engines, fallbackChain, exhaustedChats, db,
      notify: async (msg: string) => {
        await sendTelegramMessage({ client, kind: "worker-bot", chatId: queued.chatId, body: withThread({ text: msg }, queued.threadId ?? undefined) });
      },
      onCliSwitched: async (newCli: CliKind) => setUserCliPreference(db, queued.chatKey, newCli),
      compactBeforeSwitch: (request) => runCapacityFallbackCompaction(request, {
        db, runCli, bots: config.bots, configuredChain: compactionProviderChain, compactProfile: "engineering",
      }),
    });
  });
}

// ── setMyCommands — merge worker + interactive (CLI) commands ─────────────────

const defaultCli: CliKind = "codex";
await engines[defaultCli].recoverPendingQueues();
const workerCmds = buildWorkerCommands();
const interactiveCmds = buildInteractiveCommands(defaultCli);
const workerCmdSet = new Set(workerCmds.map(c => c.command));
const mergedCommands = [...workerCmds, ...interactiveCmds.filter(c => !workerCmdSet.has(c.command))];

await client.setMyCommands({ commands: mergedCommands })
  .catch((err: unknown) => console.warn("[worker-bot] setMyCommands failed", err));

// ── Background job executor loop ──────────────────────────────────────────────

// Async runner: keeps the polling loop responsive during git/gh/npm children
// and loads GH_TOKEN from the secrets file for gh API calls.
const runWorkerCommand = createRunCommand({ loadGhToken: true });

// Per-job workspaces: implementation jobs clone the local checkout instead of
// mutating it in place. Cleanup only ever deletes inside the workspace base.
const cleanupWorkspace = createWorkspaceCleanup();

function buildWorkerTestEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const next = { ...env };
  delete next.WORKER_DEFAULT_REPO;
  delete next.WORKER_ENABLED;
  delete next.WORKER_NOTIFY_CHAT_ID;
  return next;
}

// Test runner returning pass/fail rather than throwing — the TDD handler
// needs a red run to fail and a green run to pass.
const runTests = async (cwd: string): Promise<{ ok: boolean; output: string }> => {
  try {
    const output = await runWorkerCommand("npm", ["test"], { cwd, env: buildWorkerTestEnv() });
    return { ok: true, output };
  } catch (err) {
    return { ok: false, output: err instanceof Error ? err.message : String(err) };
  }
};

const advisorCheckpoint = advisorConfig.enabled ? async (input: {
  mode: "plan" | "pr_ready";
  taskKey: string;
  task: string;
  repoPath: string;
  diffSummary?: string;
  testOutput?: string;
}): Promise<string> => {
  const advisorService = new AdvisorService({ db, config: advisorConfig, bots: config.bots, runCli });
  const result = await advisorService.requestTrusted({
    origin: "worker",
    scopeKey: `worker:${input.taskKey}`,
    taskKey: input.taskKey,
    mode: input.mode,
    task: input.task,
    activeProvider: codeCliChain[0] ?? "codex",
    activeModel: null,
    evidence: { diffSummary: input.diffSummary, testOutput: input.testOutput },
    cwd: input.repoPath,
  });
  return [result.adviceMd, ...result.risks.map((risk) => `Risk: ${risk}`), ...result.suggestedNextSteps.map((step) => `Next: ${step}`)].join("\n");
} : undefined;

const jobExecutor = startJobExecutorLoop({
  db,
  workerId: `worker-bot-${process.pid}`,
  handlers: {
    defect_scan: createDefectScanHandler({
      runCli: (cmd, args, cwd) => runCliWithFallback(cmd, args, cwd ?? process.cwd(), scribeCliChain, { effort: workerEffortForTask("defect_scan") }),
      command: scribeCommand,
      resolveRepoPath: (repository) => resolveLocalRepoPath(repository),
      autoTriage: true,
      runCommand: (binary, args) => runWorkerCommand(binary, args),
      prepareWorkspace: (repository, workItemId) => prepareWorkspace({
        repository,
        workItemId,
        installDeps: (dir) => runWorkerCommand("npm", ["ci", "--no-audit", "--no-fund", "--include=dev"], { cwd: dir }).then(() => undefined),
      }),
      cleanupWorkspace,
    }),
    feature_plan: createFeaturePlanHandler({
      runCli: (cmd, args, cwd) => runCliWithFallback(cmd, args, cwd ?? process.cwd(), scribeCliChain, { timeoutMs: 20 * 60 * 1000, effort: workerEffortForTask("feature_plan") }),
      command: scribeCommand,
    }),
    refactor_scan: createRefactorScanHandler({
      runCli: (cmd, args, cwd) => runCliWithFallback(cmd, args, cwd ?? process.cwd(), scribeCliChain, { timeoutMs: 10 * 60 * 1000, effort: workerEffortForTask("defect_scan") }),
      command: scribeCommand,
      resolveRepoPath: (repository) => resolveLocalRepoPath(repository),
      runCommand: (binary, args) => runWorkerCommand(binary, args),
    }),
    implementation_plan: createImplementationPlanHandler({
      runCli: (cmd, args, cwd) => runCliWithFallback(cmd, args, cwd ?? process.cwd(), scribeCliChain, { timeoutMs: 10 * 60 * 1000, effort: workerEffortForTask("feature_plan") }),
      command: scribeCommand,
      runCommand: (cmd, args) => runWorkerCommand(cmd, args),
      resolveRepoPath: (repository) => resolveLocalRepoPath(repository),
    }),
    tdd_implementation: createTddImplementationHandler({
      runCli: (cmd, args, cwd) => runCliWithFallback(cmd, args, cwd ?? process.cwd(), codeCliChain, { timeoutMs: 15 * 60 * 1000, effort: workerEffortForTask("tdd_implementation") }),
      command: codeCommand,
      // File edits only — bash stays gated; the handler runs tests itself
      cliExtraArgs: ["--permission-mode", "acceptEdits"],
      runGit: (args, cwd) => runWorkerCommand("git", args, { cwd }),
      runTests,
      prepareWorkspace: (repository, workItemId, opts) => prepareWorkspace({
        repository,
        workItemId,
        reuseExisting: opts?.reuseExisting,
        // --include=dev: the service runs with NODE_ENV=production, which would
        // otherwise omit devDependencies — and the test runner lives there
        installDeps: (dir) => runWorkerCommand("npm", ["ci", "--no-audit", "--no-fund", "--include=dev"], { cwd: dir }).then(() => undefined),
      }),
      cleanupWorkspace,
    }),
    orchestrated_task: createOrchestratedTaskHandler({
      runCli: (cmd, args, cwd) => runCliWithFallback(cmd, args, cwd ?? process.cwd(), codeCliChain, { timeoutMs: 15 * 60 * 1000, effort: workerEffortForTask("orchestrated_task") }),
      command: codeCommand,
      commands: {
        codex: process.env.CODEX_COMMAND || "codex",
        claude: process.env.CLAUDE_COMMAND || "claude",
      },
      cliExtraArgs: ["--permission-mode", "acceptEdits"],
      runGit: (args, cwd) => runWorkerCommand("git", args, { cwd }),
      runTests,
      prepareWorkspace: (repository, workItemId, opts) => prepareWorkspace({
        repository,
        workItemId,
        reuseExisting: opts?.reuseExisting,
        installDeps: (dir) => runWorkerCommand("npm", ["ci", "--no-audit", "--no-fund", "--include=dev"], { cwd: dir }).then(() => undefined),
      }),
      cleanupWorkspace,
      advisorCheckpoint,
    }),
    open_github_issue: createGithubIssueHandler({
      runCommand: (binary, args) => runWorkerCommand(binary, args),
    }),
    pr_lifecycle: createPrLifecycleHandler({
      runGit: (args, cwd) => runWorkerCommand("git", args, { cwd }),
      runCommand: (binary, args) => runWorkerCommand(binary, args),
      cleanupWorkspace,
      maxOpenPrs: Number(process.env.WORKER_MAX_OPEN_PRS || 3),
      maxDailyPrs: Number(process.env.WORKER_MAX_DAILY_PRS || 3),
    }),
    pr_watch: createPrWatchHandler({
      runCommand: (binary, args) => runWorkerCommand(binary, args),
      staleHours: prStaleHours,
      notifyStale: async (stalePrs) => {
        const notifyChatId = Number(process.env.WORKER_NOTIFY_CHAT_ID);
        if (!notifyChatId) return;
        const lines = stalePrs.map(p =>
          `PR #${p.pr_number} in \`${p.repository}\` is stale`
        ).join("\n");
        const buttons = stalePrs.map(p => [
          { text: "🔄 Refresh", callback_data: `pr:${p.id}:rfsh` },
          { text: "⏸ Hold", callback_data: `pr:${p.id}:hold` },
          { text: "✗ Close", callback_data: `pr:${p.id}:clse` },
        ]);
        await sendTelegramMessage({
          client, kind: "worker-bot", chatId: notifyChatId,
          body: { text: `Stale PR digest:\n${lines}`, reply_markup: { inline_keyboard: buttons } },
        });
      },
    }),
    pr_refresh: createPrRefreshHandler({
      runGit: (args, cwd) => runWorkerCommand("git", args, { cwd }),
      runCommand: (binary, args) => runWorkerCommand(binary, args),
      runTests,
      cleanupWorkspace,
    }),
  },
  sendMessage: async (chatId: number, text: string, replyMarkup?: object, threadId?: number) => {
    const body: any = { text };
    if (threadId != null) body.message_thread_id = threadId;
    if (replyMarkup) body.reply_markup = replyMarkup;
    await sendTelegramMessage({ client, kind: "worker-bot", chatId, body });
  },
  sendApprovalPack: async (chatId, pack, threadId) => {
    await sendApprovalHtmlPack(client, chatId, pack, threadId);
  },
  intervalMs: jobPollIntervalMs,
});

let shouldExit = false;

const handleShutdown = () => {
  console.log("[worker-bot] SIGTERM/SIGINT received. Stopping job claims...");
  shouldExit = true;
  jobExecutor.stop();

  const checkExit = () => {
    if (jobExecutor.isIdle()) {
      console.log("[worker-bot] Idle. Exiting process.");
      process.exit(0);
    } else {
      console.log("[worker-bot] Job in progress. Waiting to exit...");
      setTimeout(checkExit, 1000);
    }
  };
  checkExit();
};

process.once("SIGTERM", handleShutdown);
process.once("SIGINT", handleShutdown);

// Enqueue a pr_watch job once per hour (idempotency key prevents duplicates within the window)
function enqueuePrWatch() {
  const dateHour = new Date().toISOString().slice(0, 13); // e.g. "2026-06-11T19"
  db.createWorkJob({ task_type: "pr_watch", idempotency_key: `pr_watch:${dateHour}`, max_attempts: 1 });
}
enqueuePrWatch();
setInterval(enqueuePrWatch, prWatchIntervalMs);

console.log(
  `[worker-bot] starting (workerEnabled=${workerEnabled}, ` +
  `interactiveChain=${cliChain.join(",")}, codeChain=${codeCliChain.join(",")}, ` +
  `scribeChain=${scribeCliChain.join(",")}, roleAssignments=${roleAssignmentRevision?.status ?? "not_configured"}, ` +
  `jobPollIntervalMs=${jobPollIntervalMs})`,
);

let offset = 0;

for (;;) {
  if (shouldExit) break;
  try {
    const updates = await client.getUpdates({ offset, timeout: 30, allowed_updates: ["message", "callback_query"] });

    for (const update of (updates.result as any) ?? []) {
      const updateId: number = update.update_id;
      offset = updateId + 1;

      try {
        const callbackQuery = update.callback_query;
        if (callbackQuery) {
          // Handle CLI switch callbacks (cli:codex, cli:claude, cli:antigravity)
          const cbqUserId = callbackQuery.from ? String(callbackQuery.from.id) : null;
          if (cbqUserId && allowedUserIds.has(cbqUserId)) {
            const cliSwitch = handleCliSwitchCallback(callbackQuery.data || "");
            if (cliSwitch) {
              const cbqChatId = callbackQuery.message?.chat?.id;
              const cbqChatKey = resolveUpdateChatKey(update as TelegramUpdate);
              if (cbqChatKey) {
                setUserCliPreference(db, cbqChatKey, cliSwitch);
                fallbackChain.setActiveCli(cbqChatKey, cliSwitch);
                applyManualCliSwitchHandoff(db, cbqChatKey, cliSwitch);
                await client.answerCallbackQuery({ callback_query_id: callbackQuery.id });
                if (callbackQuery.message?.message_id && cbqChatId) {
                  await client.editMessageText({
                    chat_id: cbqChatId,
                    message_id: callbackQuery.message.message_id,
                    text: buildCliStatusText(cliSwitch),
                    reply_markup: buildCliKeyboard(cliSwitch),
                  }).catch(() => {});
                }
              }
              continue;
            }
          }
          const [action, targetKind] = String(callbackQuery.data || "").split(":");
          if (action === "model" && targetKind && engines[targetKind]) {
            await engines[targetKind].handleCallback(callbackQuery);
            continue;
          }
          await handleWorkerCallback(callbackQuery, db, client, allowedUserIds);
          continue;
        }

        const message = (update as TelegramUpdate).message;
        if (!message) continue;
        if (!isAuthorizedMessage(message, allowedUserIds)) continue;

        const rawText = (message.text || "").trim();
        const chatId = message.chat.id;
        const threadId = message.message_thread_id;
        const chatKey = resolveUpdateChatKey(update as TelegramUpdate) ?? String(chatId);
        const userId = message.from ? String(message.from.id) : "unknown";

        // /cli — show active CLI with switch keyboard (same as interactive bot)
        if (isCliCommandText(rawText)) {
          const activeCli = getUserCliPreference(db, chatKey);
          fallbackChain.setActiveCli(chatKey, activeCli);
          await sendTelegramMessage({
            client, kind: "worker-bot", chatId,
            body: withThread({ text: buildCliStatusText(activeCli), reply_markup: buildCliKeyboard(activeCli) }, threadId),
          });
          continue;
        }

        // Worker commands (/jobs, /issues, /review, /feature, /chain) take priority
        if (isWorkerCommand(rawText)) {
          const chatRepo = db?.getChatRepo(chatKey) ?? null;
          const result = await handleWorkerCommand(rawText, {
            workerEnabled,
            cliChain,
            cliPolicy: workerCliPolicy,
            db,
            roleScopeKey,
            chatId,
            threadId,
            userId,
            defaultRepo: chatRepo ?? process.env.WORKER_DEFAULT_REPO,
            runCommand: (binary, args) => runWorkerCommand(binary, args),
          });
          if (result) {
            const body = result.kind === "keyboard_message"
              ? { text: result.text, reply_markup: result.reply_markup }
              : { text: result.text };
            await sendTelegramMessage({ client, kind: "worker-bot", chatId, body: withThread(body, threadId) });
          }
          continue;
        }

        // Check if this plain message is a pending custom repo (from /repo → "Custom repo…")
        if (hasPendingCustomRepo(chatKey)) {
          clearPendingCustomRepo(chatKey);
          const trimmed = rawText.trim();
          if (/^[\w.\-]+\/[\w.\-]+$/.test(trimmed)) {
            db?.setChatRepo(chatKey, trimmed);
            const body = withThread({ text: `Default repo set to \`${trimmed}\` for this chat.` }, threadId);
            await sendTelegramMessage({ client, kind: "worker-bot", chatId, body });
          } else {
            const body = withThread({ text: `Invalid format. Send as \`owner/repo\` (e.g. \`microsoft/vscode\`).` }, threadId);
            await sendTelegramMessage({ client, kind: "worker-bot", chatId, body });
          }
          continue;
        }

        // Check if this plain message is a pending feature brief
        const capturedBrief = captureFeatureBrief(chatKey, rawText);
        if (capturedBrief) {
          const chatRepo = db?.getChatRepo(chatKey) ?? null;
          const defaultRepo = chatRepo ?? process.env.WORKER_DEFAULT_REPO;
          const briefResult = await handleWorkerCommand(`/feature ${capturedBrief}`, {
            workerEnabled,
            cliChain,
            cliPolicy: workerCliPolicy,
            db,
            roleScopeKey,
            chatId,
            threadId,
            userId,
            defaultRepo,
            runCommand: (binary, args) => runWorkerCommand(binary, args),
          });
          if (briefResult) {
            const body = briefResult.kind === "keyboard_message"
              ? { text: briefResult.text, reply_markup: briefResult.reply_markup }
              : { text: briefResult.text };
            await sendTelegramMessage({ client, kind: "worker-bot", chatId, body: withThread(body, threadId) });
          }
          continue;
        }

        const workflowResult = handleWorkerConversationText(rawText, {
          workerEnabled,
          cliChain,
          cliPolicy: workerCliPolicy,
          db,
          roleScopeKey,
          chatId,
          threadId,
          userId,
          defaultRepo: db?.getChatRepo(chatKey) ?? process.env.WORKER_DEFAULT_REPO,
        });
        if (workflowResult) {
          const body = workflowResult.kind === "keyboard_message"
            ? { text: workflowResult.text, reply_markup: workflowResult.reply_markup }
            : { text: workflowResult.text };
          await sendTelegramMessage({ client, kind: "worker-bot", chatId, body: withThread(body, threadId) });
          continue;
        }

        // Plain message — route to preferred CLI with interactive fallback
        await dispatchInteractiveWithFallback(update as TelegramUpdate, chatKey, {
          engines,
          fallbackChain,
          exhaustedChats,
          db,
          notify: async (msg: string) => {
            await sendTelegramMessage({ client, kind: "worker-bot", chatId, body: withThread({ text: msg }, threadId) });
          },
          onCliSwitched: async (newCli: CliKind) => {
            setUserCliPreference(db, chatKey, newCli);
          },
          compactBeforeSwitch: (request) =>
            runCapacityFallbackCompaction(request, {
              db,
              runCli,
              bots: config.bots,
              configuredChain: compactionProviderChain,
              compactProfile: "engineering",
            }),
        });
      } catch (err) {
        console.error("[worker-bot] update handling failed", err);
      }
    }
  } catch (err) {
    console.error("[worker-bot] poll error", err);
    await new Promise(r => setTimeout(r, 5000));
  }
}
