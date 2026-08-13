# Pixelproof v2 — Build Brief for Claude Code

> Paste this whole file as the opening message in a Claude Code session at the root of the
> `pixelproof` repo. It is written as an instruction set, not a description.

---

## 0. Role and posture

You are the lead engineer on Pixelproof v2. Before writing code, read the repository in full:
`README.md`, `scripts/generate.mjs`, `scripts/verify.mjs`, `skills/*/SKILL.md`, `specs/*`,
`.claude-plugin/*`, tests, and CI workflow. Then write an ADR set and a phased plan, and only
then implement, phase by phase, with a working test suite at every checkpoint.

Do not boil the ocean in one pass. Stop at each phase gate and report.

---

## 1. The thesis you are building toward

Pixelproof today is a Claude Code plugin where Claude directs, Codex generates, and Claude
verifies. That coupling is the ceiling. The valuable part of this repo is **not** image
generation — image generation is a commodity that every model vendor now ships. The valuable
part is that **an artifact is only accepted if it provably satisfies a written contract**, and
that the contract is checked by two independent tiers, one deterministic and one perceptual.

So v2's thesis:

> **Pixelproof is a model-agnostic runtime for producing and gating visual artifacts against a
> portable spec. Generators are pluggable. Judges are pluggable. The spec is the product.**

Three consequences follow, and they are the whole of v2:

1. **Any agent can host it.** Claude Code, Codex CLI, Gemini CLI, Cursor, or no agent at all
   (plain CLI in CI). Today the semantic tier only works if the host happens to be Claude with
   a Read tool. That must become one of several ways to satisfy a capability, not the only way.
2. **Any model can generate, any vision model can judge, and they can be different models.**
   Claude directs and judges, Codex shoots, Gemini shoots a second take and cross-judges. The
   multi-model setup becomes a feature (independent judgement, provider bake-off), not a
   workaround for Claude lacking a raster model.
3. **Verification is the differentiated product.** Ship the ability to run Pixelproof as a
   **visual acceptance gate in CI** — assets in a repo checked against brand and spec contracts
   on every PR. Nobody else does this well. `verify.mjs --strict` is already the seed of it.

---

## 2. Hard constraints — do not violate

- Node.js 22+, **zero required runtime dependencies**, stdlib only. `sharp` stays optional and
  its absence must keep degrading explicitly with `SKIP`, never silently.
- **No API key required for the default path.** Codex CLI via the user's existing subscription
  stays the zero-config raster default. Any key-based provider is strictly opt-in.
- **Backwards compatible.** Every currently documented flag of `scripts/generate.mjs` and
  `scripts/verify.mjs` keeps working with identical semantics. Existing specs load unchanged.
- Cross-platform: Linux, macOS, Windows. No shell-isms, no `bash` in the hot path.
- Never adopt a stale file as output. The "newest PNG created after run start" rule is a safety
  property — preserve it and test it.
- Adapters are **untrusted subprocesses**. Never `eval`, never source config as code, always
  validate adapter JSON against a schema before use, always enforce a timeout and kill the
  process group on expiry.

---

## 3. Architecture to implement

Split the repo into four layers with hard boundaries:

```
core/        spec parsing, run orchestration, retake loop, scoring, cache, reporting
providers/   things that can MAKE an artifact   (codex, gemini, openai, svg, html, comfy)
judges/      things that can SEE an artifact    (host, claude, gemini, codex, heuristic)
surfaces/    how humans and agents reach core   (cli, mcp, claude-plugin, agents-md, action)
```

`core` must have no knowledge of any specific vendor. It only knows the two contracts below.

### 3.1 Provider adapter contract

A provider is either a `.mjs` module exporting `{ id, detect, capabilities, generate }` **or**
any executable that speaks this JSON protocol on stdin/stdout. The executable form is what makes
this ecosystem-friendly: anyone can add a generator in thirty lines of any language.

Request (stdin, one JSON object):

```json
{
  "protocol": 1,
  "kind": "raster",
  "prompt": "A ceramic desk lamp on seamless white",
  "negative": "text, watermark, hands",
  "width": 1254,
  "height": 1254,
  "out": "/abs/path/output/lamp.png",
  "seed": 812345,
  "references": ["/abs/path/brand/palette.png"],
  "attempt": 2,
  "priorFailures": ["corners: expected #FFFFFF, got #E8E4DE"],
  "timeoutMs": 300000,
  "options": {}
}
```

Response (stdout, final line is a single JSON object):

```json
{
  "protocol": 1,
  "ok": true,
  "file": "/abs/path/output/lamp.png",
  "provider": "codex",
  "model": "gpt-image-1",
  "seed": 812345,
  "durationMs": 41200,
  "warnings": [],
  "meta": {}
}
```

Failure shape: `{ "protocol": 1, "ok": false, "error": { "code": "PROVIDER_UNAVAILABLE",
"message": "...", "retryable": false } }`. Define a closed error-code enum in core:
`PROVIDER_UNAVAILABLE`, `AUTH_REQUIRED`, `INVALID_REQUEST`, `TIMEOUT`, `RATE_LIMITED`,
`CONTENT_REFUSED`, `INTERNAL`.

`capabilities` is declarative and used for pre-flight rejection **before** spending a
generation: supported kinds, min/max dimensions, dimension-multiple constraint, aspect-ratio
limits, pixel-count bounds, seed support, reference-image support, transparency support. The
existing Codex size rules (multiples of 16, max edge 3840, ratio <= 3:1, pixel count
655,360-8,294,400) move out of `generate.mjs` and become **Codex's declared capability record**.
Core enforces capabilities generically for every provider.

Ship these providers in v2: `codex` (port existing), `svg` (port existing), `gemini`
(Gemini CLI subprocess, same pattern as Codex — detect on PATH, no key needed), `openai-images`
(opt-in, key-based), `html` (render an HTML/CSS template to PNG via a headless browser if one is
detected — this makes deterministic OG images and social cards possible, which is the single
highest-value practical use case and needs no image model at all).

### 3.2 Judge adapter contract

The semantic tier becomes a first-class pluggable capability with the same subprocess protocol.

Request:

```json
{
  "protocol": 1,
  "file": "/abs/path/output/lamp.png",
  "context": "Square product hero on seamless white",
  "checks": [
    { "id": "s1", "assertion": "Zero text, letters, numbers or watermarks anywhere" },
    { "id": "s2", "assertion": "No people or hands appear anywhere" }
  ]
}
```

Response:

```json
{
  "protocol": 1,
  "ok": true,
  "judge": "gemini",
  "results": [
    { "id": "s1", "verdict": "pass", "confidence": 0.94, "evidence": "no glyphs present" },
    { "id": "s2", "verdict": "fail", "confidence": 0.88, "evidence": "a hand enters lower-left" }
  ]
}
```

Verdicts are `pass | fail | unsure`. **`unsure` must never be silently coerced to `pass`** — it
escalates to the host or fails under `--strict`.

Judges to ship:

- `host` — current behaviour, and still the default when running inside an agent. As designed
  here this deadlocks: core cannot both "pause" and let the same agent process the checklist.
  [ADR 0009](./adr/0009-host-judge-handoff.md) replaces the pause with a two-step handoff instead
  — `generate --judge host` exits `2` (`PENDING_JUDGEMENT`) after writing
  `judge-request-<round>.json`, and the host agent (Claude, Codex, Gemini, whoever) opens the
  image with its own read/vision tool and runs `pixelproof judge submit` to record verdicts and
  finalize the run. This keeps the zero-cost, zero-key path alive for every agent, not just
  Claude.
- `claude` / `gemini` / `codex` — non-interactive subprocess judges for CI, where no host agent
  is present.
- `heuristic` — deterministic, no model: OCR-free text-likelihood via edge/stroke density,
  dominant-palette extraction and brand-palette distance, blank/near-uniform frame detection,
  duplicate detection against previously accepted assets via perceptual hash. Cheap pre-filters
  that kill obviously bad takes before a model ever looks. Implement pHash and palette
  extraction in pure JS over raw pixel buffers so they work whenever `sharp` is present, and
  degrade to `SKIP` when it is not.

### 3.3 Cross-judging and consensus

Because judges are pluggable, support `judge: ["claude", "gemini"]` with a `consensus` policy
(`all`, `any`, `majority`, default `all`). Disagreement between two vendors' vision models on
the same assertion is high-signal and must be surfaced in the report, not averaged away. This is
the concrete answer to "use Claude and Gemini and Codex together."

---

## 4. Spec v2

Keep v1 specs loading unchanged; add an optional `"version": 2` with these capabilities:

- **`extends`** — spec composition, so a team defines `brand.spec.json` once (palette, forbidden
  elements, tone, negative prompt, judge config) and every asset spec inherits it. Deep merge,
  arrays concatenate, child scalars win. This is what turns Pixelproof into a design-system tool.
- **`variants` / `matrix`** — one spec generates a set: an icon at 6 sizes, OG images for 12 blog
  posts, app-store screenshots for 3 device frames, a hero in light and dark. Each variant is a
  full run with its own verification and its own row in the report.
- **`negative`** — explicit exclusion prompt fed to providers that support it, and mirrored
  automatically into semantic assertions so exclusions are also *verified*, not merely requested.
- **`references`** — reference image paths for providers supporting image conditioning.
- **`judge`** — `{ "adapters": ["claude","gemini"], "consensus": "all", "onUnsure": "escalate" }`.
- **`scoring`** — optional weights per check, producing a 0-100 score used to rank attempts and
  to pick a tournament winner. Without weights, all checks weigh equally.
- **`mechanical` additions** — `palette` (list of allowed hexes plus max delta-E), `minBytes`,
  `transparencyRatio` bounds, `edgeMargin` (assert the subject does not touch the frame edge, via
  border-band variance), `dominantColor`.
- **`accept`** — `{ "minScore": 90, "requireAllSemantic": true }`.

Write a JSON Schema for spec v2 in `schema/spec.v2.json`, validate with a small hand-rolled
validator (no dependency), and add `pixelproof spec validate` and `pixelproof spec explain`
(prints, in plain English, exactly what will be checked and what will be skipped given the
current environment — this alone removes most user confusion).

---

## 5. Run model, evidence, and cache

Every invocation produces a run directory — this is what makes the tool trustworthy and
debuggable, and it is what turns a failed generation into an actionable bug report:

```
.pixelproof/runs/2026-08-13T09-21-04Z-a3f9/
  run.json          resolved spec, provider, judge, env, capability decisions
  attempt-1.png
  attempt-1.json    mechanical table + semantic verdicts + score + refinement note
  attempt-2.png
  attempt-2.json
  contact-sheet.png montage of all attempts, annotated with score and verdict
  report.md         human-readable narrative of what happened and why it ended
  report.json       machine-readable, stable schema, for CI consumption
```

Add a content-addressed cache keyed on
`sha256(promptCanonical + specCanonical + provider + model + seed + dimensions)`. A cache hit
skips generation entirely. This makes CI runs cheap and makes re-verification free. `--no-cache`
and `pixelproof cache clear` must exist.

Also emit CI-native formats: JUnit XML and SARIF, so verification failures annotate a pull
request inline.

---

## 6. New commands

Add `bin/pixelproof.mjs` with subcommands; keep the existing scripts as thin shims.

- `pixelproof doctor` — capability discovery. Prints which providers and judges are installed
  and authenticated, whether `sharp` is present, which checks are therefore available or will
  `SKIP`, and exactly what to install to close each gap. **Build this first.** It is the single
  biggest usability win and it exercises every detection path.
- `pixelproof init` — scaffold `pixelproof.config.json`, `specs/brand.spec.json`, and a sample
  asset spec, with commented explanations.
- `pixelproof generate` — existing behaviour plus variants, judges, cache, run dirs.
- `pixelproof verify --dir assets/ --spec ...` — batch verification of existing files. The CI
  gate. No generation involved.
- `pixelproof tournament --spec hero.json --providers codex,gemini,openai-images --best-of 3` —
  run every available provider in parallel, verify all outputs against one spec, score, emit a
  contact sheet, and keep the winner. This is the flagship demonstration of the multi-model
  thesis and should be the README's headline example.
- `pixelproof watch` — regenerate assets whose spec or source changed.
- `pixelproof mcp` — expose `generate`, `verify`, `doctor`, `tournament` as an MCP server over
  stdio, so Claude Desktop, Cursor, Windsurf, and anything else MCP-capable can drive Pixelproof
  without a Claude Code plugin install.

---

## 7. Surfaces — one core, four doors

- **Claude Code plugin** — current path, preserved, now delegating to `bin/pixelproof.mjs`.
- **Codex CLI** — ship `AGENTS.md` plus a `codex/` instruction bundle so Codex can be the host
  and Claude the judge (the inverse of today's arrangement). Verify this direction actually works
  end to end; it is a core claim of v2.
- **Gemini CLI** — ship `GEMINI.md` and, if the extension format supports it, an extension
  manifest.
- **CI** — a `action.yml` composite GitHub Action: `pixelproof/verify@v2` with `spec`, `dir`,
  `strict`, and `judge` inputs. Include a working example workflow that fails a PR when a
  committed asset drifts from the brand spec.

The `skills/` directory should hold host-neutral prose. Any Claude-only phrasing ("use your Read
tool") must be rewritten as capability language ("open the image with the host's image-reading
capability") with a host-specific note appended per surface.

---

## 8. Phasing — stop and report at each gate

1. **Foundations.** Extract `core/`. Define both adapter protocols and their schemas. Port Codex
   and SVG to the provider contract behind the existing CLI flags. Build `doctor`. Full test
   suite green. **Gate: no user-visible behaviour change.**
2. **Judges.** Implement `host`, `heuristic`, and one subprocess judge. Consensus policy.
   `unsure` escalation. Run directories and evidence output.
3. **Spec v2.** `extends`, `variants`, `negative`, `scoring`, `accept`, new mechanical checks,
   schema, `spec explain`.
4. **Multi-model.** Gemini and OpenAI providers, `tournament`, contact sheets, cache.
5. **Surfaces.** MCP server, `AGENTS.md`, `GEMINI.md`, GitHub Action, JUnit/SARIF, docs rewrite.
6. **Proof.** Three end-to-end worked examples in `examples/`, each with committed specs and
   report output: (a) e-commerce product hero set on seamless white, (b) OG image matrix for a
   blog via the `html` provider, (c) an app icon set with brand-palette enforcement and a CI
   workflow that blocks a deliberately off-brand asset.

---

## 9. Definition of done

- `npm test` green on Node 22 and 24, Linux/macOS/Windows, with and without `sharp` installed.
- Every v1 command in the current README produces identical output.
- A user with only Codex CLI installed, and a user with only Gemini CLI installed, can both run
  the quickstart successfully with zero configuration and zero API keys.
- `pixelproof doctor` correctly reports capabilities in four environments: no providers, Codex
  only, Gemini only, both plus `sharp`.
- Adding a new provider requires touching exactly one new file and zero files in `core/`. Prove
  it by writing a `providers/echo` test double that satisfies the contract in under 40 lines.
- A pull request that changes a committed asset off-brand fails CI with an inline annotation
  naming the violated rule.
- README rewritten around the thesis in section 1, with `tournament` as the headline example.

---

## 10. What not to do

- Do not add required npm dependencies. Do not add a framework. Do not add TypeScript build
  tooling.
- Do not make any vendor's API key mandatory for any default path.
- Do not let a model's self-report substitute for a check. A judge saying "looks good" without a
  per-assertion verdict is a protocol violation and must fail parsing.
- Do not coerce `unsure` to `pass`, do not retry silently past the `retakes` bound, and do not
  ever report an unverified artifact as accepted.
- Do not rename or remove existing public flags.

---

## 11. First response I want from you

Do not write implementation code yet. Reply with:

1. A repository audit: what already maps cleanly onto this architecture, and what is entangled.
2. The risks you see in this brief, including anything you think is wrong or over-scoped, stated
   plainly.
3. A proposed ADR list with one-line rationales.
4. A concrete Phase 1 task breakdown with file-level detail and the tests you will write first.
