import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TelegramClient } from "../src/telegram.js";

describe("TelegramClient upload response envelopes", () => {
  it("fails closed when multipart upload returns HTTP 200 with malformed JSON", async () => {
    const fakeFetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected end of JSON input");
      },
    })) as any;

    const dir = await mkdtemp(join(tmpdir(), "bridge-telegram-envelope-"));
    const filePath = join(dir, "report.pdf");
    await writeFile(filePath, "pdf");

    try {
      const client = new TelegramClient("token", fakeFetch);
      await expect(client.sendDocument(1, filePath)).rejects.toThrow(/Telegram sendDocument response/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails closed when buffered upload returns HTTP 200 without ok:true", async () => {
    const fakeFetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ result: { message_id: 123 } }),
    })) as any;

    const client = new TelegramClient("token", fakeFetch);
    await expect(client.sendDocumentBuffer({
      chat_id: 1,
      bytes: Buffer.from("hello"),
      filename: "response.txt",
      mime_type: "text/plain",
    })).rejects.toThrow(/Telegram sendDocument response/i);
  });
});
