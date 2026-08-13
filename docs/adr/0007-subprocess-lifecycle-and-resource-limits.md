# ADR 0007: Subprocess lifecycle and resource limits

## Status

Accepted.

## Context

Third-party adapters may hang, flood output, spawn descendants, or inherit more authority than the
protocol requires.

## Decision

Spawn adapter executables directly without a shell. Send one bounded request, close input, bound
stdout and stderr independently, enforce a deadline, and terminate the complete process tree on
expiry or cancellation. Use an explicit working directory and an allowlisted environment. Treat
limit violations and incomplete termination as adapter failures.

## Consequences

The portable runtime must implement Windows and Unix process-tree cleanup and test both. Concrete
byte and time limits become versioned contract constants rather than caller-controlled omissions.
