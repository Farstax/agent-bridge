import { describe, expect, it } from "vitest";
import { isCursorAuthenticated, isCursorRouteable } from "../src/providers/cursorAvailability.js";

describe("Cursor ACP availability without native status probes", () => {
  it("observes newly completed and removed cached logins on the next read", () => {
    const cached = new Set<string>();
    const options = { homeDir: "/home/agent", exists: (path: string) => cached.has(path), env: {}, failedProviders: new Set<"cursor">() };
    expect(isCursorRouteable(options)).toBe(false);
    cached.add("/home/agent/.config/cursor/auth.json");
    expect(isCursorRouteable(options)).toBe(true);
    cached.clear();
    expect(isCursorRouteable(options)).toBe(false);
  });
  it("requires verified API-key evidence instead of a bare key", () => {
    const options = { homeDir: "/no/login", exists: () => false, env: { CURSOR_API_KEY: "candidate" } };
    expect(isCursorAuthenticated({ ...options, verifyApiKey: () => false })).toBe(false);
    expect(isCursorAuthenticated({ ...options, verifyApiKey: () => true })).toBe(true);
  });
});
