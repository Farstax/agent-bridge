import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";

export class StdioRpc {
  private buffer = "";
  private nextId = 0;
  private readonly waiters = new Map<number, (message: any) => void>();
  readonly child: ChildProcessWithoutNullStreams;
  stderr = "";

  constructor(dbPath: string, workspaceRoot: string, controlDir: string) {
    this.child = spawn(join(process.cwd(), "node_modules/.bin/tsx"), ["test/support/outwardBusyAgent.ts", dbPath, workspaceRoot, controlDir], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "test" },
    });
    this.child.stderr.on("data", (chunk) => { this.stderr += chunk; });
    this.child.stdout.on("data", (chunk) => {
      this.buffer += chunk;
      for (let index = this.buffer.indexOf("\n"); index >= 0; index = this.buffer.indexOf("\n")) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (message.id !== undefined && this.waiters.has(message.id)) { this.waiters.get(message.id)!(message); this.waiters.delete(message.id); }
      }
    });
  }

  request(method: string, params: unknown): Promise<any> {
    const id = ++this.nextId;
    return new Promise((resolve) => {
      this.waiters.set(id, resolve);
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  notify(method: string, params: unknown): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async initialize(): Promise<any> {
    return this.request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "test" } });
  }

  kill(signal: NodeJS.Signals = "SIGKILL"): Promise<void> {
    return new Promise((resolve) => { this.child.once("exit", () => resolve()); this.child.kill(signal); });
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode) return;
    this.child.stdin.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { this.child.kill("SIGKILL"); }, 5000);
      this.child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
}

export async function waitFor<T>(read: () => T | undefined | null | false | Promise<T | undefined | null | false>, timeoutMs = 20000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
