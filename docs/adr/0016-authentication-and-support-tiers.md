# ADR 0016: Authentication and support tiers

## Status

Accepted.

## Context

The original brief treated Gemini CLI consumer login as a zero-key generation path. Google's
dated deprecation notice says consumer Gemini Code Assist and "Login with Google" service ended
on 2026-06-18.

## Decision

Codex through the user's existing subscription remains the zero-config local default.
Google/Gemini is not advertised as a zero-key path and is out of Phase 1 entirely. When it lands,
it is opt-in and key/cloud-based. The controlling source is the
[Google deprecation notice](https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals),
dated 2026-06-18 and last updated 2026-06-23.

## Consequences

Phase 1 capability discovery must not claim consumer Gemini availability. Later Google support
must name its credential and cloud requirements explicitly.

Maintainer confirmation: the maintainer made this call on 2026-08-13.
