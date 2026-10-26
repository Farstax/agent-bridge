import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { promptBlocks } from "../src/providers/acpRuntime.js";
import type { ProviderInvocationRequest } from "../src/providers/types.js";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function upload(name: string, body: string | Buffer): string {
  const root = mkdtempSync(join(tmpdir(), "bridge-uploads-test-"));
  roots.push(root);
  const path = join(root, name);
  writeFileSync(path, body);
  return path;
}

function blocks(prompt: string, attachments: string[]) {
  return promptBlocks({ prompt, attachments, outputDir: null, soulContext: null, includeResponseContract: false } as unknown as ProviderInvocationRequest);
}

describe("ACP prompt attachments", () => {
  it.each([
    ["report.csv", "text/csv"],
    ["notes.txt", "text/plain"],
    ["data.json", "application/json"],
    ["doc.pdf", "application/pdf"],
    ["blob.xyz", "application/octet-stream"],
  ])("presents %s as a resource link with a readable path, never an image block", (name, mimeType) => {
    const path = upload(name, "a,b\n1,2\n");
    const result = blocks("read this", [path]);
    expect(result.map((block) => block.type)).toEqual(["text", "resource_link"]);
    expect(result[1]).toMatchObject({ type: "resource_link", name, mimeType, uri: pathToFileURL(path).href });
    const text = (result[0] as { text: string }).text;
    expect(text).toContain(`[Attached file saved at: ${path}]`);
    expect(JSON.stringify(result)).not.toContain(Buffer.from("a,b\n1,2\n").toString("base64"));
  });

  it("presents a caption-less CSV as an attached readable document", () => {
    const path = upload("rows.csv", "h\n1\n");
    const text = (blocks("", [path])[0] as { text: string }).text;
    expect(text).toContain(path);
  });

  it("keeps real images as image blocks (control)", () => {
    const path = upload("photo.png", Buffer.from([1, 2, 3]));
    const result = blocks("look", [path]);
    expect(result[1]).toMatchObject({ type: "image", mimeType: "image/png", data: Buffer.from([1, 2, 3]).toString("base64") });
    expect((result[0] as { text: string }).text).not.toContain("Attached file saved at");
  });

  it("encodes filenames with spaces as a valid file URI and keeps attachment order", () => {
    const first = upload("my data.csv", "x");
    const second = upload("b.json", "{}");
    const result = blocks("go", [first, second]);
    expect(result[1]).toMatchObject({ uri: pathToFileURL(first).href, name: "my data.csv" });
    expect((result[1] as { uri: string }).uri).toContain("my%20data.csv");
    expect(result[2]).toMatchObject({ name: "b.json" });
  });

  it("fails explicitly when an attachment is missing or unreadable", () => {
    const path = upload("gone.csv", "x");
    rmSync(path);
    expect(() => blocks("go", [path])).toThrow(/Attachment gone\.csv is not readable by the bridge/);
    const locked = upload("locked.csv", "x");
    chmodSync(locked, 0o000);
    if (process.getuid?.() !== 0) expect(() => blocks("go", [locked])).toThrow(/not readable by the bridge/);
  });
});
