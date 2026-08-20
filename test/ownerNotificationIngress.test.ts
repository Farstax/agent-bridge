import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import {
  startOwnerNotificationIngress,
  type OwnerNotificationIngress,
} from "../src/ownerNotificationIngress.js";

const dirs: string[] = [];
const ingresses: OwnerNotificationIngress[] = [];

afterEach(async () => {
  for (const ingress of ingresses.splice(0)) await ingress.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempSocket(name = "notify.sock"): string {
  const dir = join(tmpdir(), `owner-notify-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  return join(dir, name);
}

function post(socketPath: string, body: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      socketPath,
      path: "/notify",
      method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

function fakeClient() {
  return { sendMessage: vi.fn(async () => ({ ok: true })) } as any;
}

describe("interactive owner notification ingress (#453)", () => {
  it("delivers bounded text to the sole configured owner and does not accept a target", async () => {
    const socketPath = tempSocket();
    const client = fakeClient();
    const ingress = await startOwnerNotificationIngress({
      socketPath,
      allowedUserIds: new Set(["42"]),
      client,
    });
    ingresses.push(ingress);

    const response = await post(socketPath, { text: "Company cycle 1 completed." });

    expect(response.status).toBe(202);
    expect(client.sendMessage).toHaveBeenCalledWith(42, "Company cycle 1 completed.");

    const rejected = await post(socketPath, { text: "wrong target", chatId: 99 });
    expect(rejected.status).toBe(400);
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("fails closed unless there is exactly one configured owner", async () => {
    const client = fakeClient();
    await expect(startOwnerNotificationIngress({
      socketPath: tempSocket("none.sock"),
      allowedUserIds: new Set(),
      client,
    })).rejects.toThrow(/exactly one/i);
    await expect(startOwnerNotificationIngress({
      socketPath: tempSocket("many.sock"),
      allowedUserIds: new Set(["42", "43"]),
      client,
    })).rejects.toThrow(/exactly one/i);
  });

  it("rejects malformed and oversized bodies without delivering", async () => {
    const socketPath = tempSocket();
    const client = fakeClient();
    const ingress = await startOwnerNotificationIngress({
      socketPath,
      allowedUserIds: new Set(["42"]),
      client,
    });
    ingresses.push(ingress);

    expect((await post(socketPath, {})).status).toBe(400);
    expect((await post(socketPath, { text: "" })).status).toBe(400);
    expect((await post(socketPath, { text: "x".repeat(4097) })).status).toBe(413);
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  it("refuses to replace a non-socket or live socket path and removes a stale socket safely", async () => {
    const nonSocket = tempSocket("not-a-socket");
    writeFileSync(nonSocket, "keep me");
    await expect(startOwnerNotificationIngress({
      socketPath: nonSocket,
      allowedUserIds: new Set(["42"]),
      client: fakeClient(),
    })).rejects.toThrow(/non-socket/i);
    expect(existsSync(nonSocket)).toBe(true);

    const staleSocket = tempSocket("stale.sock");
    const holderProc = spawn(process.execPath, ["-e", `
      const http = require("http");
      const server = http.createServer();
      server.listen(process.argv[1], () => { process.stdout.write("ready\\n"); });
    `, staleSocket], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("holder process did not report ready")), 5000);
      holderProc.stdout!.once("data", () => { clearTimeout(timer); resolve(); });
      holderProc.once("error", reject);
    });

    await expect(startOwnerNotificationIngress({
      socketPath: staleSocket,
      allowedUserIds: new Set(["42"]),
      client: fakeClient(),
    })).rejects.toThrow(/active|listening/i);
    expect(existsSync(staleSocket)).toBe(true);

    holderProc.kill("SIGKILL");
    await new Promise<void>((resolve) => holderProc.once("exit", () => resolve()));
    expect(existsSync(staleSocket)).toBe(true);
    expect(lstatSync(staleSocket).isSocket()).toBe(true);

    const ingress = await startOwnerNotificationIngress({
      socketPath: staleSocket,
      allowedUserIds: new Set(["42"]),
      client: fakeClient(),
    });
    ingresses.push(ingress);
    expect(lstatSync(staleSocket).isSocket()).toBe(true);
  });

  it("requires an absolute socket path and unlinks it on shutdown", async () => {
    await expect(startOwnerNotificationIngress({
      socketPath: "relative.sock",
      allowedUserIds: new Set(["42"]),
      client: fakeClient(),
    })).rejects.toThrow(/absolute/i);

    const socketPath = tempSocket();
    const ingress = await startOwnerNotificationIngress({
      socketPath,
      allowedUserIds: new Set(["42"]),
      client: fakeClient(),
    });
    expect(existsSync(socketPath)).toBe(true);
    await ingress.stop();
    expect(existsSync(socketPath)).toBe(false);
  });

});
