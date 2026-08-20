import type { BridgeDb } from "./db.js";
import type { TelegramMessage } from "./types.js";
import { getAutonomousGoal, getAutonomousSupervisorState } from "./autonomousGoalRuntime.js";

export type AutonomyTelegramCommand = "approve" | "status" | "stop";
export type AutonomousTelegramSupervisorReply = {
  goalId: string;
  phase: "active" | "successor";
  text: string;
  idempotencyKey: string;
};

export function parseAutonomyTelegramCommand(rawText: string, botUsername?: string | null): AutonomyTelegramCommand | null {
  const parts = rawText.trim().split(/\s+/);
  const head = parts[0]?.toLowerCase() ?? "";
  const bare = head === "/autonomy";
  const suffixed = Boolean(botUsername) && head === `/autonomy@${botUsername!.toLowerCase()}`;
  if (!bare && !suffixed) return null;
  const operation = (parts[1] ?? "status").toLowerCase();
  return operation === "approve" || operation === "status" || operation === "stop" ? operation : null;
}

function matchGoalReply(
  db: BridgeDb,
  goalId: string,
  phase: "active" | "successor",
  message: TelegramMessage,
  replyId: number,
  senderId: number,
  text: string,
): AutonomousTelegramSupervisorReply | null {
  const state = getAutonomousSupervisorState(db, goalId);
  if (!state || state.route.surface !== "telegram") return null;
  if (state.route.address !== String(message.chat.id)) return null;
  if (state.route.identity !== undefined && state.route.identity !== String(senderId)) return null;
  const threadId = message.message_thread_id === undefined ? undefined : String(message.message_thread_id);
  if (state.route.thread !== threadId) return null;
  if (!state.messageIds.includes(replyId)) return null;
  return {
    goalId,
    phase,
    text,
    idempotencyKey: `${goalId}:${phase}:telegram:${message.chat.id}:${message.message_id}`,
  };
}

export function matchAutonomousTelegramSupervisorReply(db: BridgeDb, message: TelegramMessage): AutonomousTelegramSupervisorReply | null {
  const replyId = message.reply_to_message?.message_id;
  const senderId = message.from?.id;
  const text = (message.text ?? message.caption ?? "").trim();
  if (!replyId || senderId == null || !text) return null;
  if (/^\/autonomy(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.test(text)) return null;

  const active = db.raw.prepare("SELECT goal_id FROM autonomous_goals WHERE status = 'active' ORDER BY created_at DESC, goal_id DESC").all() as Array<{ goal_id: string }>;
  if (active.length > 1) throw new Error("multiple active autonomous Episodes; refusing ambiguous supervisor reply");
  if (active.length === 1) {
    const goal = getAutonomousGoal(db, active[0].goal_id);
    if (goal.status !== "active") return null;
    return matchGoalReply(db, goal.goalId, "active", message, replyId, senderId, text);
  }

  const terminal = db.raw.prepare("SELECT goal_id FROM autonomous_goals WHERE status <> 'active' ORDER BY created_at DESC, goal_id DESC LIMIT 1").get() as { goal_id: string } | undefined;
  if (!terminal) return null;
  return matchGoalReply(db, terminal.goal_id, "successor", message, replyId, senderId, text);
}
