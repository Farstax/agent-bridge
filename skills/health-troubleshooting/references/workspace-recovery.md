# Managed workspace recovery

Use this recovery knowledge only when the current workspace is managed by a platform that advertises backup recovery (for example, a Farstax-managed customer workspace). It is knowledge, not authority.

## Scope

- Recovery knowledge applies only to the current logical customer workspace.
- Do not infer, enumerate, request, or discuss other customers' workspaces or backups.
- Never request or expose infrastructure-provider credentials, server IDs, raw backup IDs, or unrelated platform inventory.
- A skill never grants permission to restore infrastructure or perform another consequential action.
- Infrastructure restore remains platform-owned. An explicitly authorised agent capability may submit a recovery request for the current workspace, but it does not give the agent provider credentials or direct restore authority.

## When to recommend recovery

Prefer ordinary evidence-led repair when the current state can be repaired safely. Recommend platform recovery when evidence indicates that local repair is inappropriate, for example:

- durable workspace state was accidentally deleted or corrupted;
- a known-bad change affected state that cannot be reconstructed safely;
- the workspace host or durable filesystem has been lost;
- the customer explicitly asks to return the workspace to an earlier recovery point.

Do not recommend restore merely because a service is unhealthy. Diagnose first.

## Recovery choices

### Restore this workspace

This is a destructive rollback of the current logical workspace to a selected managed recovery point.

- The same logical workspace remains in use.
- It should not create an additional workspace charge.
- Changes made after the selected recovery point can be lost.
- The customer must use the platform's explicit destructive confirmation flow.
- The agent may explain or submit an explicitly authorised recovery request, but the platform performs the infrastructure restore.

When discussing this option, state the recovery-point timestamp and expected data-loss boundary if the platform has supplied them. Do not invent backup availability or timestamps.

### Create recovery copy

This is a non-destructive recovery into a separate logical workspace.

- The source workspace remains unchanged.
- The new workspace is a separate billable workspace when the platform's normal additional-workspace pricing applies.
- The exact incremental recurring price must come from the platform; never estimate or invent it.
- A restored copy can contain inherited chat/provider credentials and execution identities. It must remain fenced until the platform has assigned its new identity and rebound or disabled integrations that cannot safely be cloned.
- If the platform cannot quote/authorise the additional workspace or cannot guarantee fencing, report that the recovery copy is unavailable rather than working around the boundary.

## Customer flow

When a platform restore is required:

1. Explain why local repair is no longer the preferred path.
2. For a Farstax-managed workspace, direct the customer to that workspace's **Danger zone → Recovery** controls.
3. Explain the difference between **Restore this workspace** and **Create recovery copy**.
4. Use only recovery points and prices returned by the platform for the current workspace.
5. Do not claim recovery is complete merely because a restore request was accepted.

## Post-restore qualification

After the platform reports that infrastructure recovery has completed, verify the smallest authoritative set relevant to the incident:

- expected workspace/repository files and durable application data are present;
- Agent Bridge services required by the workspace are healthy;
- the current workspace identity and routing are correct;
- integrations that should be active are connected once, not duplicated;
- the application or health boundary that triggered recovery now passes;
- the approved Agent Bridge release is active, or the platform has completed its guarded upgrade;
- managed backup protection remains enabled when that status is available through the platform.

If qualification fails, report recovery as incomplete and preserve the evidence. Do not stack speculative repairs on top of an unqualified restore.
