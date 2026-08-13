# ADR 0005: Adapter manifest and discovery

## Status

Accepted.

## Context

Core cannot preflight an adapter unless identity, protocol version, trust class, executable or
built-in entry point, and capabilities are available before generation or judging.

## Decision

Every adapter exposes a versioned, declarative manifest that is validated as data before use.
Bundled adapters publish that manifest with their trusted module. Third-party adapters are found
only through explicit configuration that names an executable and its manifest; discovery never
scans for or imports project modules. Duplicate IDs fail, and discovery order is deterministic.

## Consequences

Capability rejection and `doctor` can run before paid work. Adding a provider does not require a
core edit, while stale or invalid third-party metadata fails closed at the adapter boundary.
