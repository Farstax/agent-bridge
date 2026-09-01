from pathlib import Path

path = Path("src/interactiveBot.ts")
source = path.read_text()
marker = "export async function dispatchInteractiveTurnWithFallback("
if source.count(marker) != 1:
    raise SystemExit(f"expected one dispatch marker, found {source.count(marker)}")
prefix = source.split(marker, 1)[0]
replacement = r'''interface InteractiveFallbackExecution {
  chatKey: string;
  execute: (engine: InteractiveDispatchEngine) => Promise<ExecutionOutcome>;
  recoverPendingQueue: boolean;
  exhaustedOutcome: ExecutionOutcome;
}

async function dispatchInteractiveExecutionWithFallback(
  execution: InteractiveFallbackExecution,
  deps: InteractiveDispatchDeps,
  tried: Set<string>,
): Promise<ExecutionOutcome> {
  const { chatKey } = execution;
  const { engines, fallbackChain, exhaustedChats, db, notify, onCliSwitched } = deps;
  exhaustedChats.delete(chatKey);
  if (tried.size === 0) {
    const pref = getUserCliPreference(db, chatKey);
    fallbackChain.setActiveCli(chatKey, pref);
  }

  const activeCli = fallbackChain.getActiveCli(chatKey) as CliKind;
  tried.add(activeCli);
  const engine = engines[activeCli];
  if (!engine) throw new Error(`No engine configured for CLI ${activeCli}`);
  const outcome = await execution.execute(engine);

  if (exhaustedChats.has(chatKey)) {
    exhaustedChats.delete(chatKey);
    let next: CliKind | null = null;
    for (const cli of fallbackChain.getChain()) {
      if (!tried.has(cli)) {
        next = cli as CliKind;
        break;
      }
    }
    if (next) {
      prepareCliHandoff(db, chatKey, next, `fallback_from_${activeCli}`);
      fallbackChain.setActiveCli(chatKey, next);
      await notify(`Switching to ${next} (${activeCli} at capacity)`);
      if (onCliSwitched) await onCliSwitched(next);
      if (execution.recoverPendingQueue && engines[next].recoverPendingQueue) {
        markPendingFallbackResume(fallbackChain, chatKey, tried);
        try {
          const hasPending = await engines[next].recoverPendingQueue!(chatKey);
          if (hasPending) return "queued";
        } catch (error) {
          clearPendingFallbackResume(fallbackChain, chatKey);
          throw error;
        }
        clearPendingFallbackResume(fallbackChain, chatKey);
      }
      return dispatchInteractiveExecutionWithFallback(execution, deps, tried);
    }
    await notify("All CLIs are currently unavailable. Please try again later.");
    return execution.exhaustedOutcome;
  }

  if (tried.size > 1) setUserCliPreference(db, chatKey, activeCli);
  return outcome;
}

function dispatchClaimedInteractiveExecution(
  message: PendingMessage,
  chatKey: string,
  deps: InteractiveDispatchDeps,
  tried: Set<string>,
): Promise<ExecutionOutcome> {
  return dispatchInteractiveExecutionWithFallback({
    chatKey,
    recoverPendingQueue: false,
    exhaustedOutcome: "committed",
    execute: (engine) => engine.executeClaimedMessage(message),
  }, deps, tried);
}

export function dispatchInteractiveTurnWithFallback(
  turn: InteractiveTurnInput,
  deps: InteractiveDispatchDeps,
  tried = new Set<string>(),
  claimedMessage?: PendingMessage,
): Promise<ExecutionOutcome> {
  if (claimedMessage) {
    return dispatchClaimedInteractiveExecution(claimedMessage, turn.chatKey, deps, tried);
  }

  const chatKey = turn.chatKey;
  if (isResetTurn(turn)) clearInteractiveFallbackState(deps.fallbackChain, chatKey);
  return dispatchInteractiveExecutionWithFallback({
    chatKey,
    recoverPendingQueue: true,
    exhaustedOutcome: "failed",
    execute: async (engine) => {
      if (deps.legacyUpdate && !engine.handleInteractiveTurn && engine.handleUpdate) {
        await engine.handleUpdate(deps.legacyUpdate);
      } else if (engine.handleInteractiveTurn) {
        await engine.handleInteractiveTurn(turn);
      } else {
        throw new Error(`interactive engine ${deps.fallbackChain.getActiveCli(chatKey)} does not accept neutral turns`);
      }
      return "committed";
    },
  }, deps, tried);
}

/** Compatibility boundary for legacy Telegram callers. New surfaces pass a neutral turn. */
export function dispatchInteractiveWithFallback(
  update: TelegramUpdate,
  chatKey: string,
  deps: InteractiveDispatchDeps,
  tried = new Set<string>(),
  claimedMessage?: PendingMessage,
): Promise<ExecutionOutcome> {
  const turn = adaptTelegramUpdate(update, "telegram:interactive", chatKey);
  if (!turn) return Promise.resolve(claimedMessage ? "committed" : "failed");
  return dispatchInteractiveTurnWithFallback(turn, { ...deps, legacyUpdate: update }, tried, claimedMessage);
}

function isResetTurn(turn: InteractiveTurnInput): boolean {
  const command = turn.text.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  return command === "/reset" || command.startsWith("/reset@");
}

export function dispatchClaimedInteractiveWithFallback(
  message: PendingMessage,
  chatKey: string,
  deps: InteractiveDispatchDeps,
): Promise<ExecutionOutcome> {
  const resumedTries = consumePendingFallbackResume(deps.fallbackChain, chatKey);
  return dispatchClaimedInteractiveExecution(message, chatKey, deps, resumedTries ?? new Set());
}
'''
path.write_text(prefix + replacement)
