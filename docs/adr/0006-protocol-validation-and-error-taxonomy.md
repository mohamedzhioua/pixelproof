# ADR 0006: Protocol validation and error taxonomy

## Status

Accepted.

## Context

Executable adapters cross a trust boundary. Free-form JSON, partial model verdicts, and arbitrary
errors would make failures ambiguous and downstream behavior unstable.

## Decision

Validate versioned, bounded request and response objects at both sides of the boundary. Reject
unsupported protocol versions, malformed objects, unknown same-version fields, missing results,
and output-path mismatches. Public adapter failures use this closed code set:
`PROVIDER_UNAVAILABLE`, `AUTH_REQUIRED`, `INVALID_REQUEST`, `TIMEOUT`, `RATE_LIMITED`,
`CONTENT_REFUSED`, and `INTERNAL`. Unknown adapter failures map to `INTERNAL` without expanding
the taxonomy.

## Consequences

Schemas and dependency-free runtime validators must remain in parity. Callers can branch on stable
codes, while human messages remain explanatory details rather than an API.
