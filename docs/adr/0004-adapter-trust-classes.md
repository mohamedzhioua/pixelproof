# ADR 0004: Adapter trust classes

## Status

Accepted.

## Context

An imported module executes with the Pixelproof process's authority, so the brief's statement that
all adapters are untrusted subprocesses conflicts with its in-process module contract.

## Decision

Use two trust classes. Bundled adapters shipped in this repository are trusted and may be imported
in-process. Third-party adapters must be executables run out of process. Pixelproof never
auto-imports arbitrary project code.

## Consequences

Discovery and reporting must expose the trust class. Third-party execution receives protocol,
lifecycle, and resource controls; installing or configuring an executable remains an explicit user
action.

Maintainer confirmation: the maintainer made this call on 2026-08-13.
