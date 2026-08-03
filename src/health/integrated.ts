/**
 * Routing for health commands when the interactive Telegram bot owns polling.
 * Checks intentionally continue after the acknowledgement so a slow plugin
 * cannot stall the interactive update loop.
 */

export interface IntegratedHealthCommandOptions {
  rawText: string;
  botUsername?: string | null;
  chatId: number;
  runCheck: () => Promise<string>;
  getStatus: () => string;
  sendText: (text: string) => Promise<void>;
}

function commandForThisBot(rawText: string, botUsername?: string | null): string | null {
  const [command, ...args] = rawText.trim().split(/\s+/);
  if (command === "/health") return args.join(" ").toLowerCase();
  if (!botUsername || !command?.startsWith("/health@")) return null;
  if (command.slice("/health@".length).toLowerCase() !== botUsername.toLowerCase()) return null;
  return args.join(" ").toLowerCase();
}

export async function handleIntegratedHealthCommand(options: IntegratedHealthCommandOptions): Promise<boolean> {
  const argument = commandForThisBot(options.rawText, options.botUsername);
  if (argument === null) return false;
  if (argument === "status") {
    await options.sendText(options.getStatus());
    return true;
  }
  if (argument !== "") return false;

  await options.sendText("Checking health...");
  void options.runCheck()
    .then((text) => options.sendText(text))
    .catch((error: unknown) => options.sendText(`Health check failed: ${error instanceof Error ? error.message : String(error)}`))
    .catch((error: unknown) => console.error("[interactive] failed to send health result", error));
  return true;
}
