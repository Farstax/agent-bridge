# Agent Bridge FAQ

### How is Agent Bridge different from a coding agent?

It is the runtime around provider-native agents (Codex, Claude Code, Antigravity/Agy, Grok Build and Cursor), not a replacement agent. It keeps conversations, sessions, routing, fallback and recovery available through Telegram, Discord or Slack on an always-on host.

### What keeps autonomous work from looping forever or running up API charges?

Configured autonomous Goals have bounded Episodes and Cycles, reconciled by a typed disposition executable and durable receipts. Episode budgets limit that mode's continuation. Interactive Runs, scheduled routines and other continuations are not all Episodes; a Cycle can still consume significant provider usage. **There is no universal financial cap or guaranteed maximum API bill.** Configure provider-level budgets and access limits independently where supported.

### Can an agent push to main or deploy without my approval?

An authorized provider agent can operate with the credentials and host permissions made available to it. The `ship it`, `release it` and `deploy it` Skills define intended review, merge, publication and deployment workflows, but instructions alone are not a security boundary. Protect main with GitHub rulesets/branch protection, required checks and appropriately scoped credentials. Only grant infrastructure deployment authority when intended.

### Who can send commands, and can I stop execution?

Restrict Telegram senders using `TELEGRAM_ALLOWED_USER_IDS`, Discord senders using `DISCORD_ALLOWED_USER_IDS`, or Slack senders using `SLACK_ALLOWED_USER_IDS`. The `/stop` command on supported slash-command surfaces cancels the active Run with cancellation fencing and process termination; Slack has different text-command conventions. Stopping cannot undo completed side effects or guarantee termination of unrelated persistent processes.

### Where are my repositories, credentials and conversations stored?

Self-hosted checkouts and Agent Bridge SQLite state live on your host. Messaging configuration and provider sessions also live in local or provider-owned storage according to setup; production supports selected systemd credential integration. The OSS runtime does not require Farstax servers, but the coding-agent providers and external GitHub/messaging services you connect still handle data. For host authority, token handling and cloud boundaries, see [Security and hardening](SECURITY-AND-HARDENING.md).
