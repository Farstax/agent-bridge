# Advisor read-only evidence

Ordinary advisor requests may inspect the repository selected by Agent Bridge instead of relying only on caller-supplied context.

`AdvisorService` reuses the existing `AdvisorEvidenceToolBroker` when the trusted request working directory resolves to a directory. One logical advisor request may perform:

1. one tool-selection model turn;
2. at most six existing typed read-only evidence calls;
3. one final model turn using the bounded results.

The available operations remain limited to bounded repository listing, UTF-8 reads, literal search, Git status/diff/show/log, and supplied worker evidence. The existing broker remains responsible for path confinement, traversal and symlink denial, sensitive-path denial, redaction, byte and call limits, timeouts, typed results, and metadata-only audit callbacks.

Provider-native tools remain disabled for both model turns. The advisor receives no file-write, Git-mutation, arbitrary-shell, network, SQL, service-control, deployment, approval, merge, or rollback capability.

The existing worker `debug` path retains its structured verdict and evidence-citation contract. Other advisor modes retain the ordinary advisor result shape. High confidence is downgraded when selected evidence is missing, unavailable, denied, failed, exhausted, or truncated.

When the trusted working directory is unavailable, the request uses the existing context-only advisor path rather than inventing or widening repository scope.
