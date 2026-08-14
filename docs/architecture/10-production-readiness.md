# Production readiness

Before release, verify ordinary provider Runs, native sessions, continuation,
fallback, cancellation fencing, health receipts, Skills projection, guarded
rollout, and final delivery. Run focused tests, full CI, typecheck, Architecture
Lint, Release Artifact, and an exact-head independent review.

The release must contain only active provider, interactive, health, Discord,
and cleanup services. Historical Worker database tables may remain inert.
