import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { startOwnerNotificationIngress, type OwnerNotificationIngress } from "../src/ownerNotificationIngress.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

function socketPath(): string {
  const dir = join(tmpdir(), `owner-notify-durable-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "notify.sock");
}

function post(path: string, text: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ text });
    const req = http.request({ socketPath: path, path: "/notify", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

describe("durable owner notification delivery (#562)", () => {
  it("records the delivered assistant turn after Telegram succeeds", async () => {
    const path = socketPath();
    const delivered: Array<[string, string]> = [];
    const ingress: OwnerNotificationIngress = await startOwnerNotificationIngress({
      socketPath: path,
      allowedUserIds: new Set(["42"]),
      client: { sendMessage: vi.fn(async () => ({ ok: true })) },
      recordDeliveredAssistantTurn: (chatKey, text) => { delivered.push([chatKey, text]); },
    });
    cleanup.push(() => ingress.stop());

    expect(await post(path, "Workspace is ready.")).toBe(202);
    expect(delivered).toEqual([["42", "Workspace is ready."]]);
  });

  it("does not record history when Telegram delivery fails", async () => {
    const path = socketPath();
    const recordDeliveredAssistantTurn = vi.fn();
    const ingress: OwnerNotificationIngress = await startOwnerNotificationIngress({
      socketPath: path,
      allowedUserIds: new Set(["42"]),
      client: { sendMessage: vi.fn(async () => { throw new Error("telegram unavailable"); }) },
      recordDeliveredAssistantTurn,
    });
    cleanup.push(() => ingress.stop());

    expect(await post(path, "Workspace is ready.")).toBe(500);
    expect(recordDeliveredAssistantTurn).not.toHaveBeenCalled();
  });
});
