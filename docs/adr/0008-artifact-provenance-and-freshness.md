# ADR 0008: Artifact provenance and freshness

## Status

Accepted.

## Context

Freshness by modification time prevents adoption of old files but does not correlate an artifact
to a particular invocation. v0.1.2 already unified direct-target and fallback freshness behind one
`generatedFileStatus()` helper. The remaining hole is cross-run correlation: two runs sharing a
`CODEX_HOME` can recover each other's post-start images.

## Decision

A run must own its target. Prove freshness with post-start identity checks tied to that run, using
a run-owned target or isolated provider workspace. A global "newest PNG anywhere" scan is not
sufficient provenance and must not be the sole recovery mechanism.

## Consequences

Phase 1 must retain the current freshness characterization while a todo test exposes shared-home
cross-run recovery. The later provenance implementation must reject stale, foreign, and ambiguous
artifacts even when their timestamps are recent.

Maintainer confirmation: the maintainer made this call on 2026-08-13.
