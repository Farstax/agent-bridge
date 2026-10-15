# Security policy

## Reporting a vulnerability

Please report suspected security vulnerabilities **privately**. Start at the repository's [Security Advisories](https://github.com/Farstax/agent-bridge/security/advisories) page and use **Report a vulnerability** when GitHub offers that option.

Alternatively, email **security@farstax.com** to disclose the vulnerability privately. This security mailbox has been verified. If neither private reporting channel is usable, open a [public issue](https://github.com/Farstax/agent-bridge/issues/new) requesting a private contact channel **without** including an exploit, credentials, customer data or other sensitive details. Do not publish a proof of concept before a private channel is established.

Include the affected version or commit, reproduction steps, realistic impact and a minimal sanitized test case once a private exchange is available. Maintainers will triage reports and coordinate disclosure; no fixed response or remediation SLA is promised.

## Supported versions

Use the latest published qualified release. Fixes are not guaranteed for old releases or source snapshots. The exact release and supported installation paths are described in [the README](README.md) and [installation guide](docs/INITIAL-INSTALL.md).

## Trust boundary

Agent Bridge operates provider-native coding agents with the tools and permissions of its configured runtime account. On the documented production host, that account is **non-root but deliberately has unrestricted passwordless sudo**, making it effectively root-equivalent. A chat allowlist restricts who can send messages; it does not sandbox the authorized agent or prevent malicious repository instructions from affecting the host.

Agent Bridge stores local conversation/session state in SQLite and provider-owned sessions/credentials in their native locations. Source setup can keep messaging tokens in mode-0600 local configuration; production can use deployment-owned encrypted systemd credentials. The OSS runtime does not require Farstax hosting, but connected coding-agent providers, GitHub and messaging services process data according to their own terms and configuration.

See [Security and hardening](docs/SECURITY-AND-HARDENING.md) for actionable deployment controls, limitations and the distinction between the OSS runtime and Farstax-managed workspaces.
