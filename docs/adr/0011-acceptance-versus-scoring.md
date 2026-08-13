# ADR 0011: Acceptance versus scoring

## Status

Accepted.

## Context

A weighted score could otherwise allow a high total to conceal a known semantic failure, which
would contradict Pixelproof's acceptance-gate thesis.

## Decision

Semantic assertions are always hard gates. Scoring ranks eligible candidates and explains the
best failed attempt; it never waives a failed assertion.

## Consequences

Future spec, judge, and report contracts must keep assertion eligibility separate from ranking.
No `minScore` can turn an assertion failure into acceptance.

Maintainer confirmation: the maintainer made this call on 2026-08-13.
