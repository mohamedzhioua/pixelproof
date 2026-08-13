# 0010 — Check identity, tri-state verdicts, and consensus

- **Class:** Mechanical
- **Status:** Accepted
- **Date:** 2026-08-13

## Context

The semantic tier will grow from one host judge into a panel: several judges, possibly from
different vendors, answering the same assertions about the same artifact. Composition, scoring,
disagreement reporting and `unsure` handling all need to pair a verdict back to the exact
assertion it answers, across runs and across judges.

Two details force the design.

First, Spec v2's `extends` concatenates arrays. Positional identifiers (`s1`, `s2`, …) are
stable only until a parent spec gains an assertion, at which point every child identifier shifts
and cross-run comparison of "the same check" silently breaks.

Second, a vision model genuinely cannot always tell. Collapsing that into `pass` would
reintroduce exactly the failure this project exists to prevent, and collapsing it into `fail`
would make judges useless on legitimately ambiguous criteria.

## Decision

**Identity is derived from content, not position.** A check id is `s-` followed by the first ten
hex characters of the SHA-256 of the assertion text, canonicalised by trimming and collapsing
internal whitespace. Case is preserved because it can carry meaning in brand and copy rules.
Genuinely repeated assertions receive an explicit `#n` occurrence suffix so every id in a request
is unique.

**Verdicts are tri-state:** `pass`, `fail`, `unsure`. `unsure` is never promoted to `pass`. It
resolves according to an explicit `onUnsure` policy of `escalate` or `fail` — never `accept`.

**A judge must answer exactly the checks it was asked**, one result per check. Missing or extra
results are a protocol violation. A partial answer that is treated as complete is
indistinguishable from a pass, so it is rejected instead.

**Consensus policies are `all` (default), `any`, and `majority`**, and disagreement is recorded
alongside the combined verdict rather than averaged into it. Two vendors' models contradicting
each other is a signal about the artifact; flattening it to a number discards the most
informative thing the panel produced.

## Consequences

- Reordering or composing specs no longer changes check identity, so run-over-run comparison and
  caching by check remain valid.
- Reworded assertions get new identities. That is correct — a reworded assertion is a different
  assertion — but it means history does not carry across a rewording, and reports should show the
  assertion text next to the id rather than the id alone.
- Content-derived ids are opaque to humans. Reports must print the assertion, not just `s-1f4a…`.
- Callers must handle three outcomes everywhere a verdict is consumed. This is deliberate
  friction: any code path that only handles two has made a decision about ambiguity without
  saying so.

## Related

Implemented by `core/contracts/check-id.mjs` and `core/contracts/judge.mjs`; constrains
[0011 — Acceptance versus scoring](./0011-acceptance-versus-scoring.md) and the host handoff in
0009.
