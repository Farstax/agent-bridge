# Third-party notices

Agent Bridge is licensed under Apache-2.0 except for material that carries its own licence.

## Systematic debugging skill

`skills/systematic-debugging/` contains material adapted from the Superpowers `systematic-debugging` skill by Jesse Vincent.

That material is distributed under the MIT License. Its attribution and licence are preserved in `skills/systematic-debugging/SKILL.md` and `skills/systematic-debugging/LICENSE`. The repository-level Apache-2.0 licence does not replace or override that MIT licence.

## Voice transcription runtime

Managed voice-note transcription downloads and executes `whisper.cpp` from ggml-org. `whisper.cpp` is distributed under the MIT License; the pinned production source identity is recorded in `scripts/install-voice-stt.sh`.

The managed `ggml-base.en-q5_1.bin` model is a converted/quantized OpenAI Whisper model weight. OpenAI Whisper's code and model weights are released under the MIT License. The installer pins the exact model artifact by SHA-256.

These downloaded runtime artifacts remain subject to their upstream MIT licences; their use does not relicense them under Agent Bridge's Apache-2.0 licence.

## Dependencies

Third-party packages installed through the package manager remain subject to their own licences. Their inclusion as dependencies does not relicense them under Apache-2.0.
