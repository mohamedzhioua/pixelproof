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

### Ambiguity closed (2026-08-13)

Stale rejection shipped in v0.1.2. The ambiguity half is now closed: the Codex adapter selects a
recovery candidate with `selectArtifact(..., { policy: 'reject' })`, so two or more post-start
candidates fail the run with an `Ambiguous image recovery` error naming each candidate and its
mtime, instead of adopting the newest. The todo test is now a real test: two concurrent runs
sharing a `CODEX_HOME`, barrier-synchronised so both session images exist before either run
scans, and both runs fail.

Scope, stated exactly. This removes silent cross-adoption — no run can finish successfully on
another run's image. It does not make concurrent runs sharing a `CODEX_HOME` work: both fail
rather than one succeeding wrongly. That is a deliberate trade, because a failure is retryable
and visible while a wrongly adopted image passes verification and is never detected. The
narrowness is what keeps v1 compatibility: the new failure fires only where the old code guessed
(no directly written target, and more than one fresh candidate); a direct write, a single
candidate, and no candidate behave as they always did.

Still open, and not addressed here: a *single* foreign candidate. One post-start image from
another run is indistinguishable from this run's own output by timestamp alone, so it is still
adopted. Closing that needs positive identity — a run-owned output location or a session
identifier Codex reports back — not a stricter reading of the same scan. Isolating `CODEX_HOME`
per run is not the answer: Codex keeps its credentials there, so a scratch home breaks
authentication.

**Rejected refinement: grouping candidates by session directory.** The concern was that a single
run emitting several images would now fail, so ambiguity should be counted in *distinct session
directories* rather than in candidates — one directory being one session, newest-wins inside it.
It was implemented and reverted, because the premise did not survive measurement.

Counted on a real `CODEX_HOME` here: session directories hold between 0 and 47 images, so
multi-image sessions plainly exist — but every directory created by a `codex exec` run, which is
the only way this adapter invokes Codex, held exactly one. The multi-image directories are
interactive sessions, a mode this adapter never produces. The refinement therefore fixed a failure
that does not occur for our invocation, and cost real safety: two *foreign* images sharing one
session directory would group to a single origin and be adopted, where counting candidates
rejects them.

The general rule, since this will come up again: when relaxing a strict check to avoid a false
positive, confirm the false positive occurs in the usage *this code has*, not in the tool's
behaviour generally. The evidence for relaxing came from a different usage mode than the one being
protected, and the existing tests are what caught it.
