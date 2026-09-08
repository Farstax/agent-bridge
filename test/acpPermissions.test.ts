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
});
