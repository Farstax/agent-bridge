#!/usr/bin/env node
import { MAX_INSPECTION_OUTPUT_CHARS, renderAgentBridgeInspection } from "../src/runtimeInspector.js";
import { inspectVoiceRuntimeReadiness } from "../src/voiceRuntimeReadiness.js";

try {
  const args = process.argv.slice(2);
  const rendered = JSON.parse(renderAgentBridgeInspection(args)) as Record<string, unknown>;
  const voice = inspectVoiceRuntimeReadiness();
  if (args[0] === "capabilities") {
    const capabilities = Array.isArray(rendered.capabilities) ? rendered.capabilities : [];
    capabilities.push({
      id: "voice-transcription",
      owner: "agent-bridge",
      status: voice.status,
      reasonCode: voice.reasonCode,
      scope: "runtime",
      risk: "read-only",
      authorityRequired: "none",
      interface: "local whisper.cpp runtime",
    });
    rendered.capabilities = capabilities;
  } else {
    rendered.voiceTranscription = voice;
  }
  const output = JSON.stringify(rendered);
  if (output.length > MAX_INSPECTION_OUTPUT_CHARS) {
    throw new Error(`runtime inspector output exceeded ${MAX_INSPECTION_OUTPUT_CHARS} characters`);
  }
  process.stdout.write(output + "\n");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`agent-bridge-inspect: ${message}\n`);
  process.exit(1);
}
