# ADR 0003: v1 compatibility façade

## Status

Accepted.

## Context

Phase 1 extracts reusable seams from released v0.1.2. Unspecified compatibility would allow the
extraction to alter established commands accidentally.

## Decision

Freeze every documented flag, exit code, JSON field name, and documented semantic. Human-readable
prose may change only where it reports a newly detected safety failure. Legacy
`scripts/generate.mjs` and `scripts/verify.mjs` will become in-process shims over the new entry
point, never independent forks.

## Consequences

Characterization tests are the compatibility contract for later movement. Safety tightening must
be explicit and may add or clarify only the diagnostic prose needed to explain the new rejection.

Maintainer confirmation: the maintainer made this call on 2026-08-13.
