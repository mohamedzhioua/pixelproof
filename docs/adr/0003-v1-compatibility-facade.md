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

## Amendment — additive help lines (2026-08-13)

The original decision froze human-readable prose except where it reports a newly detected safety
failure. Applied literally to `--help`, that made a new flag undiscoverable by the only route a
user would try: [ADR 0009](./0009-host-judge-handoff.md) added `--judge`, `--judge-deadline` and
`--run-dir` to `generate` and `verify`, and the first implementation left all three out of both
banners to keep the freeze.

**The freeze now permits purely additive lines documenting a new flag in a v1 banner**, provided
every existing line stays byte-identical.

The reasoning is that ADR 0003 exists to prevent *behavioural* drift, and a help line adds no
behaviour. A flag whose own command's help does not mention it is a worse defect than help text
growing — it is a feature that only a reader of the source or the README can find.

What the amendment does **not** relax:

- No existing line may change. Lines may be inserted between them; none may be reworded, and the
  `Usage:` synopsis stays as it is.
- No exit code, JSON field name, flag name, or documented semantic may move. Those are the freeze
  in the form that matters.
- The characterization tests remain the contract. When a banner grows a line, the expected banner
  in `test/verify-cli.compat.test.mjs` and `test/generate-cli.compat.test.mjs` is updated
  **deliberately** — it is the evidence, so it is edited with intent and never deleted or
  loosened into a substring match.

This applies to the v1 banners only. `doctor` postdates v0.1.2 and was never frozen surface, so
its banner is ordinary prose.

Maintainer confirmation: the maintainer made **this amendment** on 2026-08-13, with the reasoning
recorded above.

## Consequences

Characterization tests are the compatibility contract for later movement. Safety tightening must
be explicit and may add or clarify only the diagnostic prose needed to explain the new rejection.

A banner is now an append-only document within a major: it can gain lines but cannot lose or
reword them, so its growth is bounded by how many flags a command accumulates.

Byte comparison alone cannot tell an addition from a rewording — it fails identically for both,
and the obvious fix for either is to paste in the new output. `test/judge-cli.test.mjs` therefore
also holds every pre-amendment line present, unchanged and in order, so that shortcut cannot
launder a reworded line past the freeze.

Maintainer confirmation: the maintainer made the original decision on 2026-08-13.
