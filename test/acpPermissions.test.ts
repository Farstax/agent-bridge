import { describe, expect, it } from "vitest";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { mapAcpPermissionRequest } from "../src/acp/permissions.js";

function request(kind: RequestPermissionRequest["toolCall"]["kind"] = "edit"): RequestPermissionRequest {
  return {
    sessionId: "acp-sess-1",
    toolCall: {
      toolCallId: "call-1",
      title: "Modify file",
      kind,
      status: "pending",
    },
    options: [
      { optionId: "allow", name: "Allow once", kind: "allow_once" },
      { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
      { optionId: "reject", name: "Reject once", kind: "reject_once" },
    ],
  };
}

describe("ACP permission mapping", () => {
  it("cancels the permission request when Bridge abort is already requested", () => {
    const response = mapAcpPermissionRequest(request(), {
      executionMode: "trusted",
      abortRequested: true,
    });
    expect(response.outcome).toEqual({ outcome: "cancelled" });
  });

  it("allows a matching once-option in trusted mode", () => {
    const response = mapAcpPermissionRequest(request("execute"), {
      executionMode: "trusted",
      abortRequested: false,
    });
    expect(response.outcome).toEqual({ outcome: "selected", optionId: "allow" });
  });

  it("rejects write/execute permission requests in safe mode", () => {
    const response = mapAcpPermissionRequest(request("edit"), {
      executionMode: "safe",
      abortRequested: false,
    });
    expect(response.outcome).toEqual({ outcome: "selected", optionId: "reject" });
  });

  it("allows read-kind permission requests in safe mode", () => {
    const response = mapAcpPermissionRequest(request("read"), {
      executionMode: "safe",
      abortRequested: false,
    });
    expect(response.outcome).toEqual({ outcome: "selected", optionId: "allow" });
  });

  it("rejects fetch permission requests in safe mode", () => {
    const response = mapAcpPermissionRequest(request("fetch"), {
      executionMode: "safe",
      abortRequested: false,
    });
    expect(response.outcome).toEqual({ outcome: "selected", optionId: "reject" });
  });

  it("settles deterministically when the agent offers no selectable options", () => {
    const response = mapAcpPermissionRequest({
      sessionId: "acp-sess-1",
      toolCall: {
        toolCallId: "call-1",
        title: "Modify file",
        kind: "edit",
        status: "pending",
      },
      options: [],
    }, {
      executionMode: "trusted",
      abortRequested: false,
    });
    expect(response.outcome).toEqual({ outcome: "cancelled" });
  });

  it("rejects move and unspecified tool kinds in safe mode", () => {
    expect(mapAcpPermissionRequest(request("move"), {
      executionMode: "safe",
      abortRequested: false,
    }).outcome).toEqual({ outcome: "selected", optionId: "reject" });
    const unspecified = request("edit");
    delete (unspecified.toolCall as { kind?: string }).kind;
    expect(mapAcpPermissionRequest(unspecified, {
      executionMode: "safe",
      abortRequested: false,
    }).outcome).toEqual({ outcome: "selected", optionId: "reject" });
  });

  describe("safe mode tool-kind authority (#1173)", () => {
    type Kind = NonNullable<RequestPermissionRequest["toolCall"]["kind"]>;
    const allKinds: Kind[] = ["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "switch_mode", "other"];
    const safeKinds = new Set<Kind>(["read", "search", "think"]);

    it.each(allKinds)("maps kind %s deterministically in safe mode", (kind) => {
      const response = mapAcpPermissionRequest(request(kind), { executionMode: "safe", abortRequested: false });
      expect(response.outcome).toEqual({ outcome: "selected", optionId: safeKinds.has(kind) ? "allow" : "reject" });
    });

    it("treats an omitted kind as 'other' and rejects it in safe mode", () => {
      const req = request("read");
      delete (req.toolCall as { kind?: unknown }).kind;
      expect(mapAcpPermissionRequest(req, { executionMode: "safe", abortRequested: false }).outcome)
        .toEqual({ outcome: "selected", optionId: "reject" });
    });

    it("does not let titles or raw input claiming a safe operation upgrade a non-safe kind", () => {
      const req = request("execute");
      req.toolCall.title = "Read file (read-only, safe)";
      (req.toolCall as { rawInput?: unknown }).rawInput = { command: "cat README.md", kind: "read" };
      expect(mapAcpPermissionRequest(req, { executionMode: "safe", abortRequested: false }).outcome)
        .toEqual({ outcome: "selected", optionId: "reject" });
    });

    it("never selects an allow option for a non-safe kind even when only allow options are offered", () => {
      const req = request("execute");
      req.options = [
        { optionId: "allow", name: "Allow once", kind: "allow_once" },
        { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
      ];
      expect(mapAcpPermissionRequest(req, { executionMode: "safe", abortRequested: false }).outcome)
        .toEqual({ outcome: "cancelled" });
    });
  });
});
