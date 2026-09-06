# Voice notes

Agent Bridge accepts short voice/audio messages as ordinary conversation input.

## Supported input

- Telegram voice notes and supported Telegram audio messages.
- Discord uploaded or recorded audio attachments that arrive through the existing attachment surface.
- A caption and its audio are one user turn. The caption is preserved before the transcript.
- Telegram topic/thread identity is preserved.
- Non-audio attachments in the same turn remain ordinary attachments.

After transcription, the text follows the same durable conversation and Run ingress as typed text. Provider selection, queueing, fallback, persistence, conversation history, topic routing, and answer delivery do not have voice-specific paths.

## Local transcription

The managed runtime uses local `whisper.cpp`; no paid or cloud speech API is used by default.

The pinned production contract is:

- whisper.cpp release `b4938` from source commit `52a939a2a762224e255d366c1182b2af4dd1a032`;
- model `ggml-base.en-q5_1.bin`, SHA-256 `4baf70dd0d7c4247ba2b81fafd9c01005ac77c2f9ef064e00dcf195d0e2fdd2f`;
- one Whisper thread/process;
- low process priority (`nice 19`);
- compressed input limit: 10 MiB;
- audio duration limit: 120 seconds;
- conversion/helper timeout: 10 seconds;
- transcription timeout: 90 seconds;
- temporary-storage budget: 32 MiB per job;
- at most one active transcription per workspace across Agent Bridge processes.

The release-owned component lives under `/var/lib/agent-bridge/stt`. Release activation validates and converges the pinned component before switching the Agent Bridge release pointer. Older Agent Bridge releases that predate the component hook remain valid rollback targets.

## Cancellation and failures

`/stop` owns the whole pre-provider ingress lifecycle. If it is accepted while audio is downloading or being transcribed, the work is aborted and that input cannot create an ordinary Run afterward. Immediately before durable Run admission, Agent Bridge synchronously transfers ownership from the pre-provider ingress fence to the existing execution-lane lifecycle; stops after that point use the normal Run/provider cancellation path.

Download deadlines cover both response headers and the complete streamed response body. A transport/helper timeout is reported as a transcription failure; it is not mistaken for a user cancellation.

Voice scratch data is operation-scoped and removed after success, failure, timeout, or cancellation. The existing temporary-artifact janitor also removes stale managed voice scratch left by a process crash. Workspace transcription concurrency uses an OS `flock`, so process death releases ownership without relying on stale PID files.

If transcription cannot run, Agent Bridge reports the failure instead of silently dropping the message. The original surface attachment is not converted into an empty or fake Run.

## Out of scope

Voice notes are not a real-time voice subsystem. Agent Bridge does not join Discord voice channels, provide full-duplex audio, synthesize spoken replies, stream partial transcripts, or add voice-specific workflow/autonomy semantics.
