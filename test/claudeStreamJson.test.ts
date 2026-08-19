import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildClaudeStreamJsonInput,
  parseClaudeStreamJsonOutput,
  encodeFileAsBase64,
} from "../src/claudeStreamJson.js";

describe("buildClaudeStreamJsonInput", () => {
  it("returns text-only shape when no attachments", () => {
    const json = buildClaudeStreamJsonInput("hello", []);
    const obj = JSON.parse(json);
    expect(obj.type).toBe("user");
    expect(obj.message.role).toBe("user");
    expect(obj.message.content).toBe("hello");
  });

  it("returns multimodal shape with image + text content array when attachments present", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bridge-test-"));
    const imgPath = join(dir, "test.png");
    const imageData = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]); // PNG magic
    await writeFile(imgPath, imageData);
    try {
      const json = buildClaudeStreamJsonInput("describe this", [imgPath]);
      const obj = JSON.parse(json);
      expect(obj.type).toBe("user");
      expect(obj.message.role).toBe("user");
      expect(Array.isArray(obj.message.content)).toBe(true);
      const imageBlock = obj.message.content.find((b: any) => b.type === "image");
      const textBlock = obj.message.content.find((b: any) => b.type === "text");
      expect(imageBlock).toBeDefined();
      expect(imageBlock.source.type).toBe("base64");
      expect(imageBlock.source.media_type).toBe("image/png");
      expect(imageBlock.source.data).toBe(imageData.toString("base64"));
      expect(textBlock.text).toBe("describe this");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("sets correct MIME type from file extension", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bridge-test-"));
    const imgPath = join(dir, "photo.jpg");
    await writeFile(imgPath, Buffer.from([255, 216, 255]));
    try {
      const json = buildClaudeStreamJsonInput("describe", [imgPath]);
      const obj = JSON.parse(json);
      const imageBlock = obj.message.content.find((b: any) => b.type === "image");
      expect(imageBlock.source.media_type).toBe("image/jpeg");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("parseClaudeStreamJsonOutput", () => {
  it("extracts result from last {type:result} line", () => {
    const stdout = [
      '{"type":"system","subtype":"init"}',
      '{"type":"assistant","message":{"content":"..."}}',
      '{"type":"result","subtype":"success","result":"The image shows a chart.","session_id":"sess_abc"}',
    ].join("\n");
    const result = parseClaudeStreamJsonOutput(stdout);
    expect(result).toEqual({ text: "The image shows a chart.", sessionId: "sess_abc" });
  });

  it("returns null when no result line is present", () => {
    const stdout = '{"type":"system","subtype":"init"}\n{"type":"assistant"}';
    const result = parseClaudeStreamJsonOutput(stdout);
    expect(result).toBeNull();
  });

  it("uses the last result line when multiple present", () => {
    const stdout = [
      '{"type":"result","subtype":"success","result":"first","session_id":"s1"}',
      '{"type":"result","subtype":"success","result":"second","session_id":"s2"}',
    ].join("\n");
    const result = parseClaudeStreamJsonOutput(stdout);
    expect(result?.text).toBe("second");
    expect(result?.sessionId).toBe("s2");
  });
});

describe("encodeFileAsBase64", () => {
  it("returns base64 data and mime type for a PNG file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bridge-test-"));
    const imgPath = join(dir, "img.png");
    const bytes = Buffer.from([137, 80, 78, 71]);
    await writeFile(imgPath, bytes);
    try {
      const { data, mimeType } = await encodeFileAsBase64(imgPath);
      expect(mimeType).toBe("image/png");
      expect(data).toBe(bytes.toString("base64"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
