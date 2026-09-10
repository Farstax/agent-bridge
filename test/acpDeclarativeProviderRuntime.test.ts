import * as acp from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { runAcpTurn } from "../src/acp/client.js";
import {
  ACP_REGISTRY_SCHEMA_VERSION,
  getLockedAcpRegistryEntry,
} from "../src/providers/acpRegistry.js";
import {
  resolveAcpProviderRuntime,
  resolveProviderRuntime,
  type AcpProviderPolicy,
} from "../src/providers/acpRuntime.js";

const fixturePolicy: AcpProviderPolicy = {
  providerId: "fixture-acp",
  registryAgentId: "fixture-agent",
  presentation: { provisionalAnswers: true },
};

describe("declarative ACP provider runtime", () => {
  it("keeps the qualified Codex registry distribution release-owned and pinned", () => {
    expect(ACP_REGISTRY_SCHEMA_VERSION).toBe("1.0.0");
    expect(getLockedAcpRegistryEntry("codex")).toEqual(expect.objectContaining({
      id: "codex-acp",
      version: "1.10.0",
      distribution: {
        npx: { package: "@agentclientprotocol/codex-acp@1.10.0" },
      },
    }));
  });

  it("resolves Codex execution, doctor, qualification and presentation from one runtime identity", () => {
    const runtime = resolveProviderRuntime("codex", {
      BRIDGE_CURRENT_RELEASE_DIR: "/opt/agent-bridge/current",
    });
    expect(runtime).toEqual(expect.objectContaining({
      providerId: "codex",
      transport: "acp-stdio",
      executable: "/opt/agent-bridge/current/node_modules/.bin/codex-acp",
      args: [],
      versionArgs: ["--version"],
      runtimeIdentity: "acp:codex-acp@1.10.0",
      provisionalAnswers: true,
    }));
  });

  it("uses the same generic ACP resolver for a fixture second provider", () => {
    const lockedEntry = {
      id: "fixture-agent",
      name: "Fixture Agent",
      version: "2.3.4",
      distribution: { npx: { package: "@example/fixture-agent@2.3.4", args: ["--acp"] } },
    } as const;
    const runtime = resolveAcpProviderRuntime(fixturePolicy, lockedEntry, {
      executable: "/release/node_modules/.bin/fixture-agent",
    });
    expect(runtime).toEqual(expect.objectContaining({
      providerId: "fixture-acp",
      transport: "acp-stdio",
      executable: "/release/node_modules/.bin/fixture-agent",
      args: ["--acp"],
      runtimeIdentity: "acp:fixture-agent@2.3.4",
      provisionalAnswers: true,
    }));
  });

  it("can invoke the standard ACP authenticate request after initialize without a provider-name branch", async () => {
    let authenticatedWith: string | null = null;
    const sessions = new Set<string>();
    const agent = acp.agent({ name: "auth-fixture" })
      .onRequest(acp.methods.agent.initialize, async () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: { loadSession: false },
        authMethods: [{ id: "workspace-token", name: "Workspace token" }],
      }))
      .onRequest(acp.methods.agent.authenticate, async (ctx) => {
        authenticatedWith = ctx.params.methodId;
        return {};
      })
      .onRequest(acp.methods.agent.session.new, async () => {
        sessions.add("fixture-session");
        return { sessionId: "fixture-session" };
      })
      .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
        expect(sessions.has(ctx.params.sessionId)).toBe(true);
        await ctx.client.notify(acp.methods.client.session.update, {
          sessionId: ctx.params.sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "authenticated" } },
        });
        return { stopReason: "end_turn" };
      });

    const result = await runAcpTurn({
      peer: agent,
      cwd: process.cwd(),
      conversationId: "conv-auth",
      runId: "run-auth",
      existingAcpSessionId: null,
      prompt: "hello",
      executionMode: "safe",
      authenticateMethodId: "workspace-token",
    });

    expect(authenticatedWith).toBe("workspace-token");
    expect(result.liveText).toBe("authenticated");
  });
});
