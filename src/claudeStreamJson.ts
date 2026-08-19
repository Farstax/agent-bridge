import { readFileSync } from "node:fs";
import { extname } from "node:path";

const MIME_MAP: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export async function encodeFileAsBase64(filePath: string): Promise<{ data: string; mimeType: string }> {
  const ext = extname(filePath).toLowerCase();
  const mimeType = MIME_MAP[ext] ?? "application/octet-stream";
  const data = readFileSync(filePath).toString("base64");
  return { data, mimeType };
}

export function buildClaudeStreamJsonInput(prompt: string, attachments: string[]): string {
  if (!attachments.length) {
    return JSON.stringify({
      type: "user",
      message: { role: "user", content: prompt },
    });
  }

  const content: any[] = [];
  for (const filePath of attachments) {
    const ext = extname(filePath).toLowerCase();
    const mimeType = MIME_MAP[ext] ?? "application/octet-stream";
    const data = readFileSync(filePath).toString("base64");
    content.push({
      type: "image",
      source: { type: "base64", media_type: mimeType, data },
    });
  }
  content.push({ type: "text", text: prompt });

  return JSON.stringify({
    type: "user",
    message: { role: "user", content },
  });
}

export function parseClaudeStreamJsonOutput(stdout: string): { text: string; sessionId: string | null } | null {
  let last: { text: string; sessionId: string | null } | null = null;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj.type === "result" && typeof obj.result === "string") {
        last = { text: obj.result, sessionId: obj.session_id ?? null };
      }
    } catch { /* skip non-JSON */ }
  }
  return last;
}
