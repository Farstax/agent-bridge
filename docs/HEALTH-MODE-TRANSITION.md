# Health bot mode transitions

Existing installations should switch health modes with the release helper rather than editing `HEALTH_BOT_MODE` alone.

After a release containing the helper is active, switch to integrated mode with:

```bash
sudo python3 /opt/agent-bridge/releases/current/scripts/configure-health-mode.py integrated
```

Return to standalone mode with:

```bash
sudo python3 /opt/agent-bridge/releases/current/scripts/configure-health-mode.py standalone
```

The helper:

- requires the destination mode's Telegram token before changing service state;
- resolves and preserves the health runtime's current `HEALTH_DB_PATH` semantics;
- writes only the private defaults files for the shared, interactive, and health services;
- writes transition defaults with mode `0600` and never prints bot tokens;
- restarts `agent-bridge-interactive.service` and `agent-bridge-health.service` together;
- validates fresh journal markers for the expected Telegram polling ownership; and
- restores the exact previous defaults and restarts both services if restart or validation fails.

In integrated mode, the interactive service owns Telegram polling and command registration. The health service remains a separate scheduler and is send-only. `/cli`, `/health`, and `/health status` are therefore served by the interactive bot.

Do not copy `TELEGRAM_BOT_TOKEN_INTERACTIVE` into a shared or world-readable configuration file, and do not start a second poller for the interactive token.
