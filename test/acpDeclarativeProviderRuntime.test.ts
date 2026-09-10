import * as acp from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import { runAcpTurn } from "../src/acp/client.js";
import {
  ACP_REGISTRY_SCHEMA_VERSION,
  getLockedAcpRegistryEntry,
} from "../src/providers/acpRegistry.js";
import {
  acpProviderIdForBotName,
  buildResolvedAcpProviderInvocation,
  resolveAcpProviderRuntime,
  resolveProviderRuntime,
  supportsProvisionalAnswers,
  type AcpProviderPolicy,
  type ResolvedProviderRuntime,
} from "../src/providers/acpRuntime.js";
import { inspectResolvedProviderRuntime } from "../src/providers/doctor.js";
import { lookupProviderSession, persistProviderSession } from "../src/providers/sessionRuntime.js";
import type { BridgeDb } from "../src/db.js";
import type { BotKind } from "../src/types.js";

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

  it("uses the release-locked Registry launcher for a fixture second provider", () => {
    const lockedEntry = {
      id: "fixture-agent",
      name: "Fixture Agent",
      version: "2.3.4",
      distribution: { npx: { package: "@example/fixture-agent@2.3.4", args: ["--acp"] } },
    } as const;
    const runtime = resolveAcpProviderRuntime(fixturePolicy, lockedEntry);
    expect(runtime).toEqual(expect.objectContaining({
      providerId: "fixture-acp",
      transport: "acp-stdio",
      executable: "npx",
      args: ["@example/fixture-agent@2.3.4", "--acp"],
      versionArgs: ["@example/fixture-agent@2.3.4", "--version"],
      runtimeIdentity: "acp:fixture-agent@2.3.4",
      provisionalAnswers: true,
    }));
    expect(buildResolvedAcpProviderInvocation(runtime, null)).toEqual({
      command: "npx",
      args: ["@example/fixture-agent@2.3.4", "--acp"],
      nativeSessionMode: "fresh",
      transport: "acp-stdio",
    });
  });

  it("lets engine presentation and session routing consume a resolved second-provider runtime", () => {
    const fixtureRuntime: ResolvedProviderRuntime = {
      providerId: "fixture-acp",
      transport: "acp-stdio",
      executable: "npx",
      args: ["@example/fixture-agent@2.3.4"],
      versionArgs: ["@example/fixture-agent@2.3.4", "--version"],
      runtimeIdentity: "acp:fixture-agent@2.3.4",
      selectedVersion: "2.3.4",
      registryAgentId: "fixture-agent",
      distribution: { npx: { package: "@example/fixture-agent@2.3.4" } },
      toolFree: false,
      provisionalAnswers: true,
    };
    const resolveFixture = () => fixtureRuntime;
    expect(supportsProvisionalAnswers("fixture", {}, resolveFixture)).toBe(true);
    expect(acpProviderIdForBotName("fixture", {}, resolveFixture)).toBe("fixture-acp");

    const db = {
      getAcpSessionBinding: vi.fn(() => ({ acpSessionId: "fixture-session" })),
      putAcpSessionBinding: vi.fn(),
      clearAcpSessionBinding: vi.fn(),
      getSession: vi.fn(),
      setSession: vi.fn(),
    } as unknown as BridgeDb;
    const kind = "fixture" as BotKind;
    expect(lookupProviderSession(db, "conversation", kind, resolveFixture)).toBe("fixture-session");
    persistProviderSession(db, "conversation", kind, "next-session", "run-1", resolveFixture);
    expect(db.putAcpSessionBinding).toHaveBeenCalledWith({
      conversationId: "conversation",
      providerId: "fixture-acp",
      acpSessionId: "next-session",
      runId: "run-1",
    });
    expect(db.setSession).not.toHaveBeenCalled();
  });

  it("passes Registry launcher version args through the generic doctor boundary", () => {
    const runtime = resolveAcpProviderRuntime(fixturePolicy, {
      id: "fixture-agent",
      name: "Fixture Agent",
      version: "2.3.4",
      distribution: { uvx: { package: "fixture-agent==2.3.4", args: ["serve"] } },
    });
    const inspectVersion = vi.fn(() => "fixture-agent 2.3.4");
    const result = inspectResolvedProviderRuntime(runtime, () => true, inspectVersion);
    expect(inspectVersion).toHaveBeenCalledWith(
      "uvx",
      ["fixture-agent==2.3.4", "--version"],
    );
    expect(result).toMatchObject({ status: "available", version: "fixture-agent 2.3.4" });
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

  it("rejects an authentication method that the ACP agent did not advertise", async () => {
    const agent = acp.agent({ name: "auth-fixture" })
      .onRequest(acp.methods.agent.initialize, async () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: { loadSession: false },
        authMethods: [{ id: "supported-method", name: "Supported method" }],
      }));

    await expect(runAcpTurn({
      peer: agent,
      cwd: process.cwd(),
      conversationId: "conv-auth-invalid",
      runId: "run-auth-invalid",
      existingAcpSessionId: null,
      prompt: "hello",
      executionMode: "safe",
      authenticateMethodId: "unknown-method",
    })).rejects.toThrow(/did not advertise authentication method/);
  });
});
