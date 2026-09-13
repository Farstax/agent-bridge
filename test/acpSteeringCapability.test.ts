import { describe, expect, it } from "vitest";
import { agentSupportsSteering } from "../src/acp/index.js";
import type { InitializeResponse } from "@agentclientprotocol/sdk";

function initWithMeta(meta: Record<string, unknown> | null | undefined): InitializeResponse {
  return {
    protocolVersion: 1,
    _meta: meta,
  } as InitializeResponse;
}

describe("agentSupportsSteering", () => {
  it("resolves steering support from the live agent's InitializeResponse, not a provider name", () => {
    expect(agentSupportsSteering(initWithMeta({ steering: { supported: true } }))).toBe(true);
  });

  it("fails closed when _meta is absent", () => {
    expect(agentSupportsSteering(initWithMeta(undefined))).toBe(false);
  });

  it("fails closed when _meta is null", () => {
    expect(agentSupportsSteering(initWithMeta(null))).toBe(false);
  });

  it("fails closed when _meta.steering is absent", () => {
    expect(agentSupportsSteering(initWithMeta({}))).toBe(false);
  });

  it("fails closed when _meta.steering.supported is false", () => {
    expect(agentSupportsSteering(initWithMeta({ steering: { supported: false } }))).toBe(false);
  });

  it("fails closed when _meta.steering.supported is a truthy non-boolean", () => {
    expect(agentSupportsSteering(initWithMeta({ steering: { supported: "true" } }))).toBe(false);
  });

  it("fails closed when _meta.steering is not an object", () => {
    expect(agentSupportsSteering(initWithMeta({ steering: "yes" }))).toBe(false);
  });
});
