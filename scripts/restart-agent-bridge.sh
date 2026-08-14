#!/usr/bin/env bash
set -euo pipefail

# Safe bridge restart helper. Install root-owned at:
#   /usr/local/sbin/restart-agent-bridge
# and grant only that path through sudoers.

delay="${RESTART_DELAY_SECONDS:-5}"
if ! [[ "$delay" =~ ^[0-9]+$ ]]; then
  echo "RESTART_DELAY_SECONDS must be a non-negative integer" >&2
  exit 2
fi

units=(
  agent-bridge-antigravity.service
  agent-bridge-claude.service
  agent-bridge-codex.service
  agent-bridge-discord-interactive.service
  agent-bridge-health.service
  agent-bridge-interactive.service
)

echo "Restarting agent bridge services in ${delay}s..."
sleep "$delay"

systemctl restart "${units[@]}"
systemctl list-units 'agent-bridge*' --all --no-pager
