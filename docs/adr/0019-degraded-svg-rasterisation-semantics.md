# 0019 — Degraded SVG rasterisation semantics

- **Class:** User-Challenge
- **Status:** Accepted
- **Date:** 2026-08-13
- **Maintainer confirmation:** decided by the maintainer on 2026-08-13, having been asked to
  choose rather than inherit.

## Context

When a caller asks the SVG provider for a `.png` and optional `sharp` is not installed, v1
writes the validated `.svg` instead, prints a warning explaining why no PNG was produced, and
**exits 0**. The user gets a usable asset and an honest explanation, just not the format they
asked for.

Porting SVG onto the provider contract (Slice 4b) surfaced that the protocol cannot express
this. `parseGenerateResponse` rejects any success response naming a file other than the
requested `out` path — deliberately, because "an adapter that writes somewhere other than the
requested path has not satisfied the request, however successful it claims to be". So the
ported provider returns `PROVIDER_UNAVAILABLE` with the validated vector named in `details`.

Both behaviours are defensible and they contradict each other:

- **v1's** treats a different-but-useful artifact as success with a caveat. Convenient; but a
  script that checks the exit code and then reads `icon.png` finds nothing there.
- **The contract's** treats "you asked for a PNG and there is no PNG" as a failure. Honest;
  but it turns a previously working, warned-about path into an error.

## Decision

**For Phase 1, both command-line surfaces keep v1's behaviour: success with a warning.**

`pixelproof generate` is a synonym for `scripts/generate.mjs`, not a new dialect. Phase 1's
gate is explicitly no user-visible behaviour change, and shipping two subtly different truths
for one operation — depending on which entry point the user happened to type — would be worse
than either behaviour on its own.

The `PROVIDER_UNAVAILABLE` response stays correct **within the provider contract**, which is
not yet the engine behind either CLI. The divergence is recorded here rather than resolved,
because it does not bite until the contract path becomes that engine.

## Consequences

- No user-visible change lands in Phase 1, and the compatibility tests stay authoritative.
- There is a real inconsistency in the tree: the contract path and the CLI path disagree about
  what a missing rasteriser means. It is documented, not hidden, and it is inert until wired.
- **When the contract path becomes the CLI's engine, this must be decided again, deliberately.**
  Whoever does that work does not get to pick by accident. The options are: keep v1 semantics
  and relax the protocol's same-path rule for a declared "substituted format" case; keep the
  protocol strict and accept that this becomes an error, with a changelog entry and a major
  version; or add an explicit `--allow-format-substitution` flag so the caller chooses.
- The strict rule is worth preserving by default. It exists because a response that claims
  success while naming a different file is exactly how a silent wrong result gets through, and
  that is the failure this project exists to prevent.

## Related

Arises from [0003 — v1 compatibility façade](./0003-v1-compatibility-facade.md) and the
provider contract in [0006](./0006-protocol-validation-and-error-taxonomy.md). Revisit
alongside [0013](./0013-pixel-engine-color-science-and-heuristic-status.md), which governs the
optional pixel engine.
