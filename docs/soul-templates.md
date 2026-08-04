# Soul template catalogue

Agent Bridge owns a versioned, release-bundled catalogue at `soul-templates/manifest.json`. The catalogue is a deployment contract for standalone installations and management surfaces such as Agent Bridge Platform.

## Templates

- **Operations Engineer** (`operations-engineer`) is the default. Use it for operating, diagnosing, maintaining, developing, releasing and deploying a live system.
- **Companion** (`companion`) is for general-purpose assistance across planning, communication, research, practical tasks and mixed technical work.
- **Minimal** (`minimal`) is a low-steering, provider-neutral baseline and a suitable starting point for a custom persona.

The root `SOUL.md` is byte-identical to the manifest's default template so existing standalone behavior and `AGENT_BRIDGE_SOUL_PATH` remain compatible.

## Consumer contract

Consumers must validate `schemaVersion`, resolve `defaultTemplateId` to a declared template, restrict template files to the catalogue directory and use the declared use cases to explain selection. They must not silently duplicate or replace the catalogue with a separate default.

A platform may copy a selected template into a managed workspace path and allow section edits, but the original template ID, release identity and source hash should remain available for provenance and reset behavior.

## Runtime selection

Standalone installations continue to use:

```bash
AGENT_BRIDGE_SOUL_PATH=/path/to/SOUL.md
AGENT_BRIDGE_SOUL_MODE=summary
```

When `AGENT_BRIDGE_SOUL_PATH` is unset, the runtime resolves `SOUL.md` from `BRIDGE_PROJECT_DIR`. Platform appliances should set an explicit stable path so repository selection cannot change the active workspace soul.
