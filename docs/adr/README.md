# Pixelproof architecture decisions

This directory records the decisions that constrain the Pixelproof v2 roadmap. Statuses describe
the decision state, not implementation progress.

| ADR | Class | Status |
| --- | --- | --- |
| [0001 — v2 scope and non-goals](./0001-v2-scope-and-non-goals.md) | User-Challenge | Accepted |
| [0002 — Four-layer dependency rule](./0002-four-layer-dependency-rule.md) | Mechanical | Accepted |
| [0003 — v1 compatibility façade](./0003-v1-compatibility-facade.md) | User-Challenge | Accepted |
| [0004 — Adapter trust classes](./0004-adapter-trust-classes.md) | User-Challenge | Accepted |
| [0005 — Adapter manifest and discovery](./0005-adapter-manifest-and-discovery.md) | Mechanical | Accepted |
| [0006 — Protocol validation and error taxonomy](./0006-protocol-validation-and-error-taxonomy.md) | Mechanical | Accepted |
| [0007 — Subprocess lifecycle and resource limits](./0007-subprocess-lifecycle-and-resource-limits.md) | Mechanical | Accepted |
| [0008 — Artifact provenance and freshness](./0008-artifact-provenance-and-freshness.md) | User-Challenge | Accepted |
| [0009 — Host judge handoff](./0009-host-judge-handoff.md) | User-Challenge | Accepted |
| [0010 — Check identity, tri-state, and consensus](./0010-check-identity-tri-state-and-consensus.md) | Mechanical | Accepted |
| [0011 — Acceptance versus scoring](./0011-acceptance-versus-scoring.md) | User-Challenge | Accepted |
| [0013 — Pixel engine, color science, and heuristic status](./0013-pixel-engine-color-science-and-heuristic-status.md) | User-Challenge | Deferred |
| [0014 — Evidence and report versioning](./0014-evidence-and-report-versioning.md) | Mechanical | Accepted |
| [0016 — Authentication and support tiers](./0016-authentication-and-support-tiers.md) | User-Challenge | Accepted |
| [0017 — Package and surface distribution](./0017-package-and-surface-distribution.md) | User-Challenge | Deferred |
| [0019 — Degraded SVG rasterisation semantics](./0019-degraded-svg-rasterisation-semantics.md) | User-Challenge | Accepted |
| [0020 — Retakes under a judged run](./0020-retakes-under-a-judged-run.md) | User-Challenge | Accepted |
| [0021 — Judge registry and subprocess judges](./0021-judge-registry-and-subprocess-judges.md) | User-Challenge | Accepted |

The macOS CI affordability decision is part of ADR 0001 because it changes release scope, not
runtime architecture. The duplicate/pHash corpus and threshold question is deferred in ADR 0013.
