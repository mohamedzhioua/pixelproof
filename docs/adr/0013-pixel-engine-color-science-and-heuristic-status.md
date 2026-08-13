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
