import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeAcpPolicy } from "../src/providers/claudeAcpPolicy.js";
import { loadProjectedClaudeMcpServers, trustedClaudeMcpServers } from "../src/providers/claudeManagedMcp.js";
import type { ProviderInvocationRequest } from "../src/providers/types.js";

function request(overrides: Partial<ProviderInvocationRequest> = {}): ProviderInvocationRequest {
  return {
    prompt: "hello",
    sessionId: null,
    command: "claude",
    model: null,
    executionMode: "safe",
    outputFormat: "stream-json",
    soulContext: null,
    attachments: [],
    outputDir: null,
    effort: null,
    toolMode: "default",
    ...overrides,
  };
}

describe("trusted Claude MCP projection", () => {
  it("keeps the managed adapter and a plain remote URL, and drops injected servers", () => {
    expect(trustedClaudeMcpServers({
      managed: {
        command: "node",
        args: ["/usr/local/bin/farstax-mcp-adapter.cjs", "--socket", "/run/agent-bridge/managed-mcp/conn_1.sock"],
      },
      registry: { url: "https://example.com/mcp" },
      injected: { command: "bash", args: ["-c", "echo secret"] },
      credentialed: { url: "https://user:token@example.com/mcp" },
      headed: { url: "https://example.com/mcp", headers: { Authorization: "Bearer secret" } },
      escaped: {
        command: "node",
        args: ["/usr/local/bin/farstax-mcp-adapter.cjs", "--socket", "/run/agent-bridge/managed-mcp/../secret.sock"],
      },
    })).toEqual({
      managed: {
        type: "stdio",
        command: "node",
        args: ["/usr/local/bin/farstax-mcp-adapter.cjs", "--socket", "/run/agent-bridge/managed-mcp/conn_1.sock"],
      },
      registry: { type: "http", url: "https://example.com/mcp" },
    });
  });

  it("passes the projected servers explicitly without enabling file-backed settings", () => {
    const home = mkdtempSync(join(tmpdir(), "claude-managed-mcp-"));
    writeFileSync(join(home, ".claude.json"), JSON.stringify({
      mcpServers: {
        managed: {
          command: "node",
          args: ["/usr/local/bin/farstax-mcp-adapter.cjs", "--socket", "/run/agent-bridge/managed-mcp/conn_1.sock"],
        },
      },
      permissions: { allow: ["Bash"] },
    }));
    const settings = claudeAcpPolicy.sessionSettings?.(request(), { HOME: home });
    expect(settings?.meta).toEqual({
      systemPrompt: { append: expect.any(String) },
      claudeCode: {
        options: {
          settingSources: [],
          strictMcpConfig: true,
          mcpServers: {
            managed: {
              type: "stdio",
              command: "node",
              args: ["/usr/local/bin/farstax-mcp-adapter.cjs", "--socket", "/run/agent-bridge/managed-mcp/conn_1.sock"],
            },
          },
        },
      },
    });
    expect(loadProjectedClaudeMcpServers({ HOME: join(home, "missing") })).toEqual({});
  });
});
