# ADR 0002: Four-layer dependency rule

## Status

Accepted.

## Context

The v1 scripts mix surface parsing, orchestration, vendor behavior, and verification. Pixelproof
needs stable boundaries before that code moves.

## Decision

Keep the four product layers `surfaces/`, `core/`, `providers/`, and `judges/`. Surfaces call core;
core depends only on shared contracts and injected adapter values; providers and judges implement
those contracts. Core must not import a vendor implementation, and adapters must not import a
surface or core orchestration. Contract modules are the deepest shared seam.

## Consequences

Dependency-boundary tests can enforce vendor-neutral core behavior. Provider and judge selection
belongs at composition/discovery boundaries rather than inside core algorithms.
