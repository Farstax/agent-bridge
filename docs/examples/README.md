# Examples

These are source/self-hosting recipes built from Agent Bridge's existing runtime and configuration surfaces. They are not alternate configuration contracts: the root `.env.*.example` files remain the canonical environment templates.

- [Telegram with multiple providers](telegram-multi-provider.md) — detect installed coding-agent CLIs, create the interactive config, and switch providers from one bot.
- [Telegram topic workstreams](telegram-topic-workstreams.md) — use forum topics as isolated durable workstreams without binding a topic to one provider.
- [Discord interactive](discord-interactive.md) — run the switchable Discord surface against a repository.
- [Scheduled routines](scheduled-routines.md) — create one-shot or recurring work that enters the same ordinary Run path as interactive work.

For production host installation and guarded releases, use [Initial installation](../INITIAL-INSTALL.md) and [Guarded rollout](../GUARDED-ROLLOUT.md) instead of these source recipes.
