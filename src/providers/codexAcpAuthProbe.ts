import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { resolveCodexAcpArgs, resolveCodexAcpCommand } from "./codexAcpConfig.js";

const ACP_AUTH_PROBE_TIMEOUT_MS = 15_000;
const ACP_AUTH_PROBE_PROMPT = "Reply with exactly OK.";

function killProcessGroup(child: ChildProcess): void {
  if (child.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
      return;
    } catch {
      // Fall back to the direct child below when the process group is already gone.
    }
  }
  try { child.kill("SIGTERM"); } catch { /* already exited */ }
}

/**
 * Verify CODEX_API_KEY through the selected Codex ACP adapter itself. This is
 * deliberately independent of the legacy `codex exec` runtime: initialize,
 * explicit ACP api-key authentication, then one bounded no-tool prompt prove
 * the same credential/runtime pair that production will actually use.
 */
export async function runCodexAcpApiKeyProbe(
  env: Record<string, string | undefined>,
): Promise<void> {
  if (!env.CODEX_API_KEY?.trim()) throw new Error("CODEX_API_KEY is not configured");

  const root = mkdtempSync(join(tmpdir(), "agent-bridge-codex-acp-auth-"));
  const command = resolveCodexAcpCommand(env);
  const args = resolveCodexAcpArgs(env);
  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    HOME: root,
    CODEX_HOME: join(root, ".codex"),
    NO_BROWSER: "1",
    INITIAL_AGENT_MODE: "agent",
  };
  // The probe authenticates explicitly. A caller-provided default request
  // must not create a second, implicit auth path inside session/new.
  delete childEnv.DEFAULT_AUTH_REQUEST;

  const child = spawn(command, args, {
    cwd: root,
    env: childEnv,
    shell: false,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let settled = false;
  let timer: NodeJS.Timeout | null = null;
  child.stderr?.on("data", () => { /* drain without logging credential-adjacent diagnostics */ });

  const spawnFailure = new Promise<never>((_resolve, reject) => {
    child.once("error", reject);
  });
  // Reject an unexpected clean/failed child exit too; otherwise a closed ACP
  // stream can race the timeout and obscure the actual runtime failure.
  const earlyClose = new Promise<never>((_resolve, reject) => {
    child.once("close", (code, signal) => {
      if (!settled) reject(new Error(`Codex ACP auth probe exited early (code=${String(code)} signal=${String(signal)})`));
    });
  });
  // Attach sinks immediately so a same-tick spawn failure/close never becomes
  // an unhandled rejection if another race branch wins first.
  spawnFailure.catch(() => undefined);
  earlyClose.catch(() => undefined);

  try {
    if (!child.stdin || !child.stdout) throw new Error("Codex ACP auth probe is missing stdio pipes");
    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin),
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );
    const client = acp.client({ name: "agent-bridge-auth-probe" })
      .onRequest(acp.methods.client.session.requestPermission, () => ({
        outcome: { outcome: "cancelled" },
      }))
      .onNotification(acp.methods.client.session.update, () => undefined);

    const probe = client.connectWith(stream, async (agent) => {
      await agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "agent-bridge-auth-probe", version: "1" },
      });
      await agent.request(acp.methods.agent.authenticate, { methodId: "api-key" });
      const session = await agent.request(acp.methods.agent.session.new, {
        cwd: root,
        mcpServers: [],
      });
      const result = await agent.request(acp.methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: ACP_AUTH_PROBE_PROMPT }],
      });
      if (result.stopReason === "cancelled") {
        throw new Error("Codex ACP auth probe was cancelled");
      }
    });

    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Codex ACP auth probe timed out after ${ACP_AUTH_PROBE_TIMEOUT_MS}ms`)), ACP_AUTH_PROBE_TIMEOUT_MS);
    });
    await Promise.race([probe, spawnFailure, earlyClose, timeout]);
  } finally {
    settled = true;
    if (timer) clearTimeout(timer);
    try { child.stdin?.end(); } catch { /* already closed */ }
    killProcessGroup(child);
    rmSync(root, { recursive: true, force: true });
  }
}
