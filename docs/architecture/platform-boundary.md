# Runtime and deployment ownership

## Runtime responsibilities

Agent Bridge owns provider-native CLI invocation, sessions, recoverable Runs, conversation state, scheduling through ordinary Runs, cancellation/fencing, routing and delivery. Provider agents retain reasoning, tools and engineering workflow ownership. See [architecture overview](overview.md) and [repository instructions](../../AGENTS.md).

## Deployment responsibilities

The operator or host environment owns machine/workspace provisioning, host access, credential delivery, service installation and the selection of immutable releases. Those responsibilities are external to the OSS runtime; no hosted control plane is required.

A deployment may start, stop, configure and upgrade Agent Bridge services using supported install and release interfaces. It does not own provider-native agent reasoning or repository engineering decisions. Agent Bridge does not assume any specific cloud provider, billing service, tenant model or deployment product.

## Security and qualification

Runtime identity, external credentials and host authority follow the selected deployment environment. Protect credentials and host access as described in [security and hardening](../SECURITY-AND-HARDENING.md). Use the [initial installer](../INITIAL-INSTALL.md) and [guarded rollout](../GUARDED-ROLLOUT.md) for supported release lifecycle operations.
