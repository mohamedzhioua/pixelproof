# 0014 — Evidence and report versioning

- **Class:** Mechanical
- **Status:** Accepted
- **Date:** 2026-08-13

## Context

Phase 2 makes Pixelproof write things down. Until now the tool printed and exited; from the run
directory onward it produces files that outlive the process — `run.json`, `attempt-<n>.json`,
`report.json`, `report.md` — and other software will read them. [`V2-BRIEF.md`](../V2-BRIEF.md) §5
says `report.json` is "machine-readable, stable schema, for CI consumption", and
[0009 — Host judge handoff](./0009-host-judge-handoff.md) §2 makes `run.json` the *single source of
truth* for whether a run is open, with no index beside it.

That combination is what forces this decision to come first. A pending run is a file that a
*different invocation*, possibly of a *different build*, has to read and act on. The moment
`run.json` exists on someone's disk, its shape is a compatibility surface, and a shape that was
never declared cannot be kept. Versioning after the first write is not versioning; it is an
apology.

Two things are already decided and must not be re-litigated here. ADR 0009 §2 reserves `state`,
`judge-request-<round>.json` and `judge-result-<round>.json` inside this envelope and defers the
rest to this ADR. And the *protocol* boundary is already versioned by `protocol: 1` in
`core/contracts/`, with a policy — [0006](./0006-protocol-validation-and-error-taxonomy.md) — of
rejecting unknown same-version fields. Evidence files are not protocol messages, and the difference
turns out to matter (§4).

## Decision

### 1. One name, one integer, in a `schema` field

Every persisted envelope carries `schema: "<envelope>/<major>"` as its first field:

| File | `schema` | Owner |
| --- | --- | --- |
| `run.json` | `pixelproof.run/1` | this ADR |
| `report.json` | `pixelproof.report/1` | this ADR |
| `attempt-<n>.json` | `pixelproof.attempt/1` | this ADR |
| `judge-request-<round>.json` | `pixelproof.judge-pending/1` | ADR 0009 |
| `judge-result-<round>.json` | `pixelproof.judge-result/1` | ADR 0009 |

A single integer major. **No minor version**, because a minor is only useful to a reader that can
behave differently on it, and the read rule below gives it nothing to do: additive change needs no
signal, and anything a reader must notice is a major.

`run.v1.json` and `report.v1.json` under `schema/` are the reference documents for the two
envelopes a consumer reads; `pixelproof.attempt/1` is internal evidence and ships no schema
document until something outside this repo needs to read it.

The envelope carries a *name* as well as a number, unlike the bare `protocol: 1` of the adapter
contract. A protocol message arrives on a channel whose kind is already known from context; an
evidence file is found on a disk, by a tool that may have been pointed at the wrong directory. The
name is what makes `PENDING_SCHEMA_UNSUPPORTED` distinguishable from "this is not one of ours at
all".

**Read rule: exact major, or refuse.** A build reads only the majors it declares. An unrecognised
name or major is refused by code — `RUN_SCHEMA_UNSUPPORTED` (§6) — and never parsed best-effort. A
half-understood run record is worse than no run record: it is the "silent wrong result" this
project exists to prevent, wearing the costume of forward compatibility.

### 2. What is guaranteed stable within a major

These are the fields a consumer may rely on. They will not be removed, renamed or retyped while
the major stays `1`.

`run.json`:

- `schema`, `runId`, `state`, `accepted`, `createdAt`, `updatedAt`, `attempts[]`, `outcome`,
  `reasons[]`.
- `runId` matches `^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z-[0-9a-f]{8}$` and equals the run
  directory's basename. The hyphen time separator is ADR 0009's, for the reason ADR 0009 gives: a
  colon is not a legal Windows filename character.
- `state ∈ {running, pending-judgement, accepted, rejected, abandoned}` — **closed within the
  major**. Adding a state is a major bump, because a consumer that switches exhaustively on `state`
  is doing the right thing and must not be punished for it.
- `accepted` is a **projection of `state`**, never an independent field: `true` only in `accepted`,
  `null` in `running`, `false` in every other state — which satisfies ADR 0009 §4's "`accepted:
  false` explicitly while pending" without a second thing that can disagree with the first.
- `attempts[]` is ordered by `number` ascending, `number` starts at 1 and is contiguous. Each entry
  has `number`, `recordedAt`, `artifact` (`path`, `bytes`, `sha256`) and `verification` (`ok`,
  `passed`, `failed`, `skipped`, `strict`).
- `outcome` is `null` until the run is final, then `{state, reason, acceptedAttempt, finalisedAt}`.
- Every timestamp is ISO-8601 UTC ending in `Z`.
- **Every path in a field this ADR defines is relative to the run directory, with `/`
  separators.** Not absolute. A run directory that is copied, archived, or mounted at a different
  path in a container stays readable — and ADR 0009 §3 explicitly declines to pin a run to a
  hostname, so pinning it to an absolute path would take back with one hand what that decision gave
  with the other. The exception is a nested record carried *verbatim* from its producer —
  `resolved`, and the `verification` block inside `attempt-<n>.json` — which keeps whatever its
  producer put in it, for the same reason §3 leaves its interior free: this ADR does not own that
  shape and must not silently rewrite it.

`report.json` guarantees `schema`, `runId`, `state`, `accepted`, `outcome`, `attempts[]`,
`summary` (`attempts`, `passed`, `failed`, `skipped`) and `reasons[]`, with the same meanings. The
report is a *finalisation* record: it exists only for a run in a terminal state, and it is written
on abandonment as well as on acceptance (ADR 0009 §2), because a run that ended badly is the case
where evidence is worth most.

`summary` counts come from the **decisive attempt** — the accepted one if there is one, otherwise
the last recorded — not from a sum across attempts. Adding up four attempts' failures produces a
number that describes no artifact.

### 3. What may change freely

- **`report.md` in its entirety.** It is prose for a human, it is not versioned, and nothing may
  parse it. It carries no `schema` field precisely so that no one is tempted.
- The interior of `resolved` (the resolved spec/provider/judge/env record) — a diagnostic bag whose
  keys follow whatever the surface currently resolves. Its *presence* is stable; its shape is not.
- The text of any human-facing `message`, `note` or `warning`. Codes are stable; prose is not.
- Additive fields anywhere. A newer build may add optional fields to any envelope without a bump.
- Timestamp precision beyond whole seconds, and the ordering of arrays other than `attempts`.

### 4. Writer strict, reader tolerant of fields and intolerant of majors

The reader accepts unknown *fields* and refuses unknown *majors*. That is the mirror image of ADR
0006's "reject unknown same-version fields", and the asymmetry is deliberate rather than an
oversight.

An adapter message is input from a process this build does not control; an unknown field there may
be an instruction being silently dropped, so rejecting is the safe read. An evidence file is
output, written by this tool for consumers. If a CI job that reads `report.json` hard-failed on a
field a newer Pixelproof added, then every upgrade would be a breaking change for every consumer,
and the practical result would be nobody upgrading. Tolerating unknown fields is what makes the
additive path in §3 real.

A missing *required* field is not tolerated on either side. That is malformed, not new.

### 5. Names reserved now, so later work cannot collide

Reserved inside a run directory, whether or not this phase writes them: `run.json`, `report.json`,
`report.md`, `attempt-<n>.png`, `attempt-<n>.json`, `contact-sheet.png` (brief §5),
`judge-request-<round>.json` and `judge-result-<round>.json` (ADR 0009 §2). Reserved keys in
`run.json`: `judge` and `rounds` for ADR 0009, `cache` for ADR 0015.

There is **no index file** anywhere in the run root. Enumeration scans `<root>/*/run.json`, as ADR
0009 §2 requires — an index is a second thing that can disagree with the truth.

### 6. Run-rejection codes are their own closed set

Reading and transitioning runs fails with a `RunError` carrying one of: `RUN_ID_MALFORMED`,
`RUN_FOREIGN_ROOT`, `RUN_NOT_FOUND`, `RUN_SCHEMA_UNSUPPORTED`, `RUN_STATE_TRANSITION_REFUSED`,
`RUN_CLOSED`. These do **not** extend ADR 0006's closed adapter enum — no adapter is involved in
reading a file this tool wrote — and they are not ADR 0009's `PENDING_*` reasons either. ADR 0009's
`judge submit` codes are a layer above: `PENDING_ID_MALFORMED` and `PENDING_FOREIGN_ROOT` are that
command's names for what the store reports as `RUN_ID_MALFORMED` and `RUN_FOREIGN_ROOT`, and
`PENDING_NOT_OPEN` is its name for a `RUN_STATE_TRANSITION_REFUSED` out of a terminal state. Two
vocabularies, one mechanism.

### 7. What a major bump costs, and when it is required

A bump is required to remove or retype a guaranteed field, to add or rename a `state`, to change
the run id format, or to make paths absolute. A bump is **not** a migration: old run directories
are never rewritten in place, because rewriting evidence to suit a newer reader is the one thing
evidence must not do. A build that meets a major it does not speak says so and stops. Abandoned and
superseded run directories are retained (ADR 0009 §4), so a repository may hold several majors at
once, and enumeration must survive that — an unreadable or unsupported run is listed with its
error, not skipped silently.

## Consequences

- The persisted vocabulary is fixed before the first write, which is the entire point of ordering
  this ADR ahead of the run-directory implementation. The cost is that additions to the state set —
  and a `retaken` or `superseded` state is plausible — now cost a major.
- `accepted` being derived means no caller can set it. Any future code that wants to set
  `accepted` independently of `state` is a finding against this ADR, not a licence.
- Relative paths mean a reader must join against the run directory it read from. That is one line,
  and it buys archivability.
- Two versioning policies now coexist in one codebase (`protocol: 1` reject-unknown at the adapter
  boundary; `schema: "…/1"` tolerate-unknown for evidence). §4 is the answer to the reviewer who
  reads that as an inconsistency.
- `report.md` being explicitly unversioned means it can be improved freely; it also means any
  future consumer request to parse it must be answered with `report.json`.

## Related

Implements the ADR 0014 row of [`V2-PLAN.md`](../V2-PLAN.md) §3 and the run-model half of
[`V2-BRIEF.md`](../V2-BRIEF.md) §5. Carries the reservations made by
[0009 — Host judge handoff](./0009-host-judge-handoff.md) §2 (`state`, the judge round files, no
index, the run id format) and leaves the pending/submit machinery to that ADR. Deliberately
diverges from [0006 — Protocol validation and error taxonomy](./0006-protocol-validation-and-error-taxonomy.md)
on unknown fields, for the reason in §4, and does not touch its error enum. Constrained by
[0003 — v1 compatibility façade](./0003-v1-compatibility-facade.md): no run directory is created
unless a run opts in, so bare `generate` and `verify` are byte-identical. Holds `cache` open for
0015 — Cache identity and invalidation, which is not yet written.
