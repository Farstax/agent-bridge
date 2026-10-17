# Security and hardening

This is the self-hosted Agent Bridge trust model, not a claim of container isolation or a managed-cloud security certification.

## 1. Choose a trusted host boundary

Production Agent Bridge runs as a non-root service account, but [host administration authority](operations/host-administration.md) intentionally requires **unrestricted passwordless sudo** for that account. Treat anyone who can command the authorized agent, or supply malicious instructions that it executes, as potentially able to affect the entire host. A non-root unit alone does not prevent host administration.

- Prefer a dedicated machine/VM and separate credentials for agent-operated repositories, especially for untrusted code.
- Keep the operating system updated, restrict SSH and network entry points, and back up important data outside agent-writeable locations.
- Do not grant the runtime access to personal credentials or production systems that it does not need. Review what the connected provider and its tools can read, execute and transmit.
- The source setup wizard is for local/source hosts. For production, use the [immutable-release installer](INITIAL-INSTALL.md) and [guarded rollout](GUARDED-ROLLOUT.md). Do not mistake a source checkout for a hardened container image.

## 2. Allowlist messaging identities

Use the setup wizard or the exact environment names for the selected surface:

| Surface | Authorized identity setting | Reference |
| --- | --- | --- |
| Telegram | `TELEGRAM_ALLOWED_USER_IDS` (numeric Telegram user IDs) | [Telegram onboarding](examples/telegram-multi-provider.md) |
| Discord | `DISCORD_ALLOWED_USER_IDS` (Discord user snowflakes) | [Discord onboarding](examples/discord-interactive.md) |
| Slack | `SLACK_ALLOWED_USER_IDS` (Slack member IDs) | [Slack Socket Mode](slack.md) |

Use only your intended users, verify the sender's actual platform ID, and protect bot credentials. These settings restrict message ingress; they **do not** prevent an allowed user or a compromised authorized account from exercising the runtime's host privileges.

## 3. Scope GitHub and provider authority

Use repository-specific GitHub permissions where your workflow permits. Prefer fine-grained PATs to classic broad PATs **when self-configuring a PAT**; restrict selected repositories, grant only necessary permissions, and configure branch protection, mandatory reviews and required CI independently of Agent Bridge. A token's actual reach is determined by GitHub's grant—not by the repository currently selected in an agent prompt.

Provider-native CLIs manage their own authentication and remote calls. Agent Bridge cannot promise that source code, prompts or tool context remain on the self-hosted machine after a connected provider is used. Read each provider's retention/training settings.

## 4. Protect tokens and retained state

- Keep source `.env.*` files private (setup creates mode-0600 configuration) and outside commits; do not paste secrets into chat or diagnostics.
- Production has an [optional systemd encrypted credential path](INITIAL-INSTALL.md) for Telegram. Credential creation, rotation and protection are deployment-owned, not something Agent Bridge does automatically.
- Protect local SQLite databases, the selected repository checkout, provider sessions and any backups with OS-level permissions and appropriate retention.
- `/stop` cancels the active agent execution; runtime cancellation/fencing and process-tree termination are not equivalent to reversing commands that already ran or killing every persistent service that an agent may have started.
- `ship it`, `release it` and `deploy it` are documented [delivery directives](../skills/delivery-directives/SKILL.md), not OS permissions. For hard boundaries use independent GitHub, host and cloud account authorization.

## 5. Understand autonomy limits

A configured autonomous Goal can run as a bounded Episode composed of Cycles. Each Cycle enters the existing provider Run and reconciles its result via a `continue`, `done` or `blocked` disposition. Cycle and optional daily Episode limits prevent unbounded **Episode scheduling**; they do not impose a universal token, subscription or monetary spending cap. Ordinary interactive Runs and other configured continuations have their own lifecycles.

See [FAQ](FAQ.md) and [autonomous-work contract](../skills/autonomous-work/SKILL.md).

