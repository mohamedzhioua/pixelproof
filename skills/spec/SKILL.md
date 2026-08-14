---
name: spec
description: >-
  Create a reusable JSON image specification before generating or rendering an image, hero,
  icon, diagram, logo, chart, illustration, or visual asset; use when dimensions, background,
  transparency, exclusions, composition, or review criteria are not yet explicit.
---

# Pixelproof spec authoring

Turn a visual request into a small, reusable contract at `specs/<name>.json`. Keep the
interview brief: ask only for decisions that materially change the result. Usually these are
the intended use, pixel dimensions or aspect, background/transparency, required subject and
composition, forbidden content, and the number of attempts. If the user's request already
answers one of them, do not ask it again.

## Format

Write strict JSON, not JSON with comments:

```json
{
  "name": "asset-name",
  "description": "One sentence describing the intended result",
  "mechanical": {
    "width": 1254,
    "height": 1254,
    "aspect": "1:1",
    "corners": { "expect": "#FFFFFF", "tolerance": 3 },
    "alpha": "opaque",
    "maxBytes": 2000000
  },
  "semantic": [
    "The exact visible condition Claude must judge",
    "A second independently judgeable condition"
  ],
  "retakes": 3
}
```

Every `mechanical` key is optional. Supported keys are exact integer `width` and `height`,
`aspect` such as `1:1` or `16:9`, four-corner colour sampling, `alpha` (`opaque`,
`transparent`, or `any`), and maximum file size in bytes. Put appearance, subject identity,
layout, exclusions, and negative requirements in `semantic` as atomic statements that can be
marked pass or fail by looking at the image.

## Colour tolerance is mandatory judgment

Never assume exact RGB equality from a generative image model. A real request for pure white
produced corner samples such as `#FEFDFD`, `#FEFEFE`, and `#FDFDFD`; a zero-tolerance
`#FFFFFF` assertion would reject useful generations forever. Use per-channel tolerance 3 by
default. Increase it only when the use case accepts more variation, and use zero only for
deterministic, code-authored assets where byte-exact colour is truly required.

Keep semantic criteria concrete and separate. Prefer "No people or hands appear anywhere"
over "Looks professional", and split unrelated conditions so a retake's correction can name the
specific violation.

## `retakes` only means something with `--judge`

`retakes` bounds the total attempts inside a judged run (`generate --judge host`). It is not
read at all without `--judge`: a bare `generate` makes exactly one provider call regardless of
what this field says, and `--retakes` on the command line is refused without `--judge` too.
Absent, it defaults to a single attempt. Set it above 1 only when the caller intends to pass
`--judge host`.
