# ADR 0001: v2 scope and non-goals

## Status

Accepted.

## Context

The original brief made six phases one release gate. That combined foundations, evidence,
specification, CI, provider expansion, distribution, and product polish into a gate too large to
verify or roll back safely.

## Decision

Use staged releases in this order: Foundations, Evidence, CI/spec, then Expansion. The corrected
roadmap replaces the all-at-once six-phase gate. `watch` and tournament polish are deferred until
demonstrated demand. macOS CI will be added in the later CI slice: this public repository can use
GitHub-hosted macOS runners without billed minutes.

## Consequences

Each release must satisfy its own compatibility and verification gate before later work begins.
This decision records the macOS matrix commitment but does not implement it in Slice 1.

Maintainer confirmation: the maintainer made this call on 2026-08-13.
