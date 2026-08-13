# ADR 0013: Pixel engine, color science, and heuristic status

## Status

Deferred.

## Context

Palette distance, alpha compositing, ICC handling, sampling, text likelihood, and duplicate
detection require calibrated contracts and representative data that Phase 1 does not provide.

## Decision

Deferred, not decided: color-science specifics beyond sRGB/D65 CIEDE2000 when it lands, and the
duplicate/pHash corpus and threshold, remain open.

## Consequences

No heuristic acceptance threshold or expanded color contract may be inferred from Phase 1. These
questions require data and a later maintainer decision before implementation.

Maintainer confirmation: the maintainer made this call on 2026-08-13.

## Evidence gathered since

Status is unchanged — moving it off Deferred is a maintainer decision. What has
changed is that the deferred questions now have data behind them, recorded in
`docs/evidence/heuristic-calibration.md`:

- **sRGB/D65 CIEDE2000** — implemented in `core/heuristics/color.mjs` and validated against all
  34 pairs of the published supplementary dataset. Ready to decide.
- **Colour tolerance** — a single flat CIEDE2000 tolerance is measurably indefensible: the
  ±3-per-channel tolerance the project already accepts spans 0.38 to 7.01 ΔE00 across sRGB. The
  radius is derived per colour from that existing tolerance instead. Ready to decide.
- **Text likelihood** — measured and refused. Edge/stroke density does not separate text from
  ordinary texture (a plain gridline pattern scores between a heading and a paragraph of body
  copy), and nothing ships. Ready to decide, in the negative.
- **Duplicate corpus and threshold** — still open, and deliberately so. A generated corpus
  separates transformed-same-image pairs (max 18 bits) from different-image pairs (min 22 bits),
  but on synthetic assets and too few of them to say anything about the tail. The Hamming
  distance ships with no default threshold; `findDuplicates` refuses to run without an explicit
  one.
- **ICC handling and alpha compositing** — still open. The prefilters assume the decoded buffer
  is sRGB, and the compositing background is a parameter defaulting to white rather than a
  decision.

Nothing in `core/heuristics/` can mark an artifact accepted: the outcome vocabulary is REJECT,
INCONCLUSIVE and SKIP, with no accepting state, so no acceptance threshold can be inferred from
any of it.
