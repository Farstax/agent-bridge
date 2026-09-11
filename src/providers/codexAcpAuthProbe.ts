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

export interface AcpApiKeyProbeOptions {
  readonly label: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly authenticateMethodId?: string;
  readonly sessionMeta?: Readonly<Record<string, unknown>>;
  readonly prepareEnv?: (root: string, env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
}

/**
 * Verify a provider key through the exact ACP program selected for production.
 * The probe is bounded, refuses permissions, creates an isolated HOME, drains
 * diagnostics without logging them, and always tears down the process group.
 */
export async function runAcpApiKeyProbe(options: AcpApiKeyProbeOptions): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), `agent-bridge-${options.label.toLowerCase()}-acp-auth-`));
  const childEnv = options.prepareEnv
    ? options.prepareEnv(root, { ...options.env, HOME: root })
    : { ...options.env, HOME: root };

  const child = spawn(options.command, [...options.args], {
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
  const earlyClose = new Promise<never>((_resolve, reject) => {
    child.once("close", (code, signal) => {
      if (!settled) reject(new Error(`${options.label} ACP auth probe exited early (code=${String(code)} signal=${String(signal)})`));
    });
  });
  spawnFailure.catch(() => undefined);
  earlyClose.catch(() => undefined);

  try {
    if (!child.stdin || !child.stdout) throw new Error(`${options.label} ACP auth probe is missing stdio pipes`);
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
      const initialized = await agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "agent-bridge-auth-probe", version: "1" },
      });
      if (options.authenticateMethodId) {
        const supported = initialized.authMethods?.some((method) => method.id === options.authenticateMethodId);
        if (!supported) {
          throw new Error(`${options.label} ACP adapter does not advertise auth method ${options.authenticateMethodId}`);
        }
        await agent.request(acp.methods.agent.authenticate, { methodId: options.authenticateMethodId });
      }
      const session = await agent.request(acp.methods.agent.session.new, {
        ...(options.sessionMeta ? { _meta: options.sessionMeta } : {}),
        cwd: root,
        mcpServers: [],
      });
      const result = await agent.request(acp.methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: ACP_AUTH_PROBE_PROMPT }],
      });
      if (result.stopReason === "cancelled") {
        throw new Error(`${options.label} ACP auth probe was cancelled`);
      }
    });

    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${options.label} ACP auth probe timed out after ${ACP_AUTH_PROBE_TIMEOUT_MS}ms`)), ACP_AUTH_PROBE_TIMEOUT_MS);
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

/**
 * Verify CODEX_API_KEY through the selected Codex ACP adapter itself. This is
 * deliberately independent of the removed native Codex runtime.
 */
export async function runCodexAcpApiKeyProbe(
  env: Record<string, string | undefined>,
): Promise<void> {
  if (!env.CODEX_API_KEY?.trim()) throw new Error("CODEX_API_KEY is not configured");
  await runAcpApiKeyProbe({
    label: "Codex",
    command: resolveCodexAcpCommand(env),
    args: resolveCodexAcpArgs(env),
    env: { ...env },
    authenticateMethodId: "api-key",
    prepareEnv: (root, childEnv) => {
      const prepared: NodeJS.ProcessEnv = {
        ...childEnv,
        CODEX_HOME: join(root, ".codex"),
        NO_BROWSER: "1",
        INITIAL_AGENT_MODE: "agent",
      };
      // The probe authenticates explicitly. A caller-provided default request
      // must not create a second, implicit auth path inside session/new.
      delete prepared.DEFAULT_AUTH_REQUEST;
      return prepared;
    },
  });
}
