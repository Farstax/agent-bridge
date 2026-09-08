import { describe, expect, it } from "vitest";
import { bridgeInitializeRequest } from "../src/acp/capabilities.js";

describe("ACP client capability negotiation", () => {
  it("advertises plan support and protocol/client info, without filesystem or terminal capabilities", () => {
    const request = bridgeInitializeRequest();
    expect(request.clientCapabilities?.plan).toEqual({});
    expect(request.clientCapabilities?.fs).toBeUndefined();
    expect(request.clientCapabilities?.terminal).toBeUndefined();
    expect(request.clientInfo?.name).toBe("agent-bridge");
  });
});
