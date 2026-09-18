---
name: sensors
description: Use when the user wants to inspect Agent Bridge, server, or configured external sensor observations now or from a scheduled routine.
---

# Sensors

Sensors are deterministic observation-only checks. They do not schedule, investigate, remediate, or grant authority.

Derive the helper beside the existing context helper:

```sh
SENSORS="$(dirname "$AGENT_BRIDGE_CONTEXT_COMMAND")/agent-bridge-sensors"
```

List available sensors:

```sh
bash "$SENSORS" list
```

Run one sensor:

```sh
bash "$SENSORS" run server
```

Run all sensors:

```sh
bash "$SENSORS" run --all
```

Use `--json` only when structured output is useful for reasoning.

For diagnosis, treat sensor output as current evidence and use `systematic-debugging`. For future or recurring execution, use the existing `scheduled-routines` capability. Do not create a second schedule, notification, recovery, or remediation mechanism around Sensors.
