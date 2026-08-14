# Pixelproof

[![CI](https://github.com/mohamedzhioua/pixelproof/actions/workflows/test.yml/badge.svg)](https://github.com/mohamedzhioua/pixelproof/actions/workflows/test.yml)

Pixelproof is a Claude Code plugin for producing images that pass an explicit spec. Claude
Code has no raster image model, while Codex CLI can use its built-in `image_gen` tool through
the user's ChatGPT subscription credentials, with no API key. The working relationship is
simple: **Codex is the camera; Claude is the art director and the reviewer.** Claude defines
the shot, Codex generates it, and Claude reads the result back before accepting it.

## Two-tier verification

Generation is only an attempt. Pixelproof checks each attempt through two complementary
gates:

1. The mechanical tier (`scripts/verify.mjs`) checks dimensions, aspect ratio, four corner
   pixels, alpha, and file size with code and no model tokens.
2. The semantic tier is run by Claude following `skills/image/SKILL.md`: Claude reads the
   actual image and checks each requested subject, composition, exclusion, and branding rule.

The split matters. In a live probe, asking for a pure white background produced corner pixels
of `#FEFDFD`, `#FEFEFE`, and `#FDFDFD` (and a requested red centre measured `#F40101`). A
mechanical rule requiring byte-exact `#FFFFFF` would reject every otherwise-correct image.
Pixelproof therefore uses a configurable per-channel colour tolerance, defaulting to 3, while
leaving judgments such as "no invented branding" to Claude's eyes.

> **About `semantic`:** entries in a spec's `semantic` array are not checked by JavaScript.
> The agent must open the produced image with its own image-reading capability and judge
> every entry visibly, unless a subprocess judge does the looking instead. `--judge host`
> and `--judge codex` both make that a recorded step rather than a convention — see
> [`pixelproof judge`](#pixelproof-judge).

Inside a judged run, a mechanical failure is always corrected and retaken by the tool itself,
in the same process. A semantic rejection differs by judge: under `--judge host` it leaves the
run open and names the exact `pixelproof retake` command to continue it; under `--judge codex`
it is corrected and retaken in the same process too, because the verdict already arrived
there. Either way the loop is bounded by `--retakes`, else `spec.retakes`, else one attempt —
never retried forever, and nothing is promoted when the bound is spent. Without `--judge`,
`generate` makes exactly one attempt and the spec's `retakes` field is not read at all. See
[`pixelproof retake`](#pixelproof-retake).

## Install

Add this repository as a Claude Code marketplace and install the plugin:

```text
/plugin marketplace add mohamedzhioua/pixelproof
/plugin install pixelproof
```

For development from a local clone:

```sh
claude --plugin-dir /absolute/path/to/pixelproof
```

For standalone skills, copy the three skill directories into the user skill directory (use
distinct destination names), keep this repository available for its scripts, and expose its
path as `PIXELPROOF_ROOT`:

```sh
cp -R skills/image ~/.claude/skills/pixelproof-image
cp -R skills/vector ~/.claude/skills/pixelproof-vector
cp -R skills/spec ~/.claude/skills/pixelproof-spec
export PIXELPROOF_ROOT=/absolute/path/to/pixelproof
```

Plugin installs can refer to scripts through `${CLAUDE_PLUGIN_ROOT}` automatically.

## Providers

Pixelproof resolves a provider in this order: an explicit `--provider`, the
`PIXELPROOF_PROVIDER` environment variable, the `.svg` output extension, Codex found on
`PATH`, or a clear installation error. The default raster path is zero-config once Codex CLI
is installed and logged in. Pixelproof invokes:

```text
codex exec --sandbox workspace-write --skip-git-repo-check "<prompt>"
```

The child process has closed stdin, runs in the output directory, receives exact dimensions
and filename in its prompt, and is limited to that one output. If Codex instead writes to its
default `$CODEX_HOME/generated_images/<session-uuid>/exec-<uuid>.png` layout, Pixelproof
recovers the single PNG created after the run began and moves it into the requested location.
Older images are never adopted as fallback output, and if more than one post-start image is
found the run fails as ambiguous rather than picking one. The default timeout is 300 seconds.

Optional environment variables:

| Variable | Meaning |
| --- | --- |
| `PIXELPROOF_PROVIDER` | `codex` or `svg` |
| `PIXELPROOF_CODEX_MODEL` | Passed to Codex as `-m <model>` |
| `PIXELPROOF_CODEX_EFFORT` | Passed as `-c model_reasoning_effort=<effort>` |
| `PIXELPROOF_TIMEOUT_MS` | Codex timeout in milliseconds |

The SVG provider needs no external service. Claude authors SVG markup; the provider validates
well-formed XML, a root `<svg>`, and `viewBox`, then writes the asset. A `.png` target is
rasterised when optional `sharp` is installed. Without `sharp`, the validated `.svg` is kept
and a warning explains why no PNG was produced.

## Spec reference

See `specs/product-hero.example.json` for a complete example:

```json
{
  "name": "product-hero",
  "description": "Square product hero on seamless white",
  "mechanical": {
    "width": 1254,
    "height": 1254,
    "aspect": "1:1",
    "corners": { "expect": "#FFFFFF", "tolerance": 3 },
    "alpha": "opaque",
    "maxBytes": 2000000
  },
  "semantic": [
    "Zero text, letters, numbers, watermarks, labels or signage anywhere in the frame",
    "No people or hands appear anywhere"
  ],
  "retakes": 3
}
```

All mechanical keys are optional. `width` and `height` are exact positive integers. `aspect`
accepts ratios such as `1:1` and `16:9` with an absolute ratio tolerance of 0.01. `corners`
samples all four corner pixels against `expect` using per-channel `tolerance` (default 3).
`alpha` is `opaque`, `transparent` (at least one pixel has alpha below 255), or `any`.
`maxBytes` is an integer upper bound. An empty or absent mechanical block passes with a note.
`retakes` bounds the total attempts inside a judged run and is read only when `--judge` is
given; without `--judge`, `--retakes` is refused on the command line and `spec.retakes` is not
read at all — a bare `generate` makes exactly one provider call regardless of what the spec
says. It defaults to 1 attempt when absent. See [`pixelproof retake`](#pixelproof-retake).

## Standalone CLI

Everything works without Claude. There are two equivalent entry points: `bin/pixelproof.mjs`
groups the commands under one executable, and the original `scripts/*.mjs` paths keep working
unchanged. They share the same handlers in the same process, so they are synonyms rather than
two dialects — identical flags, output and exit codes.

```sh
pixelproof <command> [options]     # generate | verify | doctor | judge | retake
node bin/pixelproof.mjs verify --file lamp.png --spec specs/product-hero.example.json
node scripts/verify.mjs   --file lamp.png --spec specs/product-hero.example.json
```

The package is `private`, so `pixelproof` resolves after `npm link`; in a checkout, run
`node bin/pixelproof.mjs`.

Exit codes are `0` accepted, `1` rejected or errored, and — only under `--judge host` — `2`
for an outstanding judgement. `--judge codex` never returns `2`: its verdict arrives in the
same process, so nothing is left outstanding, and it finishes with `0` or `1` like a bare
`generate`. **`2` is never a pass**, so a gate already written as "non-zero is failure" is
correct without changing anything.

### `pixelproof doctor`

Reports what this machine can actually do, before you spend a generation finding out: which
providers are installed, each one's declared limits, and — the part that causes the most
confusion — **which mechanical checks will run and which will `SKIP`**.

```sh
pixelproof doctor                        # human report
pixelproof doctor --json                 # the same document, machine-readable
pixelproof doctor --run-dir ci/evidence  # scan a run root that is not the working directory's
```

It also reports outstanding host judgements — `N pending host judgements (M expired)` — so a
handoff left unanswered by a crashed agent is visible to someone who never knew one happened. A
scan it could not perform says so rather than reporting none.

It is read-only and never spends quota. It will not invoke a provider to generate anything,
and it deliberately does not probe authentication, because that means a network call that can
hang behind a login prompt. Credentials it cannot cheaply prove are reported as
`unknown / not safely probeable` rather than guessed at — a confident wrong "ready" is the
failure this project exists to prevent, so `doctor` does not produce one about itself.

### `pixelproof judge`

The semantic tier is the half a vision model has to answer, and the obvious shape for it
deadlocks: the agent that ran `generate` is the only entity that can open the image, and
while it waits on the child process it can neither read the file nor write the verdicts the
child is waiting for. `--judge host` replaces the wait with **two invocations that never
block on each other**.

```sh
pixelproof generate --prompt "A ceramic desk lamp" --out output/lamp.png \
  --spec specs/product-hero.example.json --judge host
# exit 2 — a checklist was written and no verdict exists yet

pixelproof judge submit --run <id> --results verdicts.json
# exit 0 accepted, 1 rejected, 2 escalated to a further round
```

`--judge codex` has no host to hand a checklist to, so it drives the Codex CLI as a judge
**in the same process** and finishes in one invocation — there is no second command to run:

```sh
pixelproof generate --prompt "A ceramic desk lamp" --out output/lamp.png \
  --spec specs/product-hero.example.json --judge codex
# exit 0 accepted, 1 rejected — never 2, because nothing is left outstanding
```

`--judge codex` is a registered **judge**, a role separate from the `codex` **provider** that
generates the image — the same vendor answers two different questions, under two different
ids in two different registries (ADR 0021 §1). Only bundled judges are supported; a judge that
is not installed on this machine is refused before any generation is spent, with the
remediation printed. `--judge-deadline` is refused with a subprocess-only panel, since nothing
stays outstanding to have a deadline — the subprocess call is bounded instead by
`PIXELPROOF_JUDGE_TIMEOUT_MS` (default 300000 ms). A panel naming more than one judge, such as
`--judge codex,host`, is specified (ADR 0009 §5) but refused by name in this build: it is not
silently reduced to its first entry.

Escalation needs a host to escalate *to*. With no `host` in the panel, an `unsure` verdict
that would otherwise open a second round is instead **rejected** — recorded as
`semantic-unsure`, with the message telling the operator to add `,host` to `--judge` if a
human tie-breaker is wanted. A semantic rejection from `--judge codex` with the retake bound
unspent is corrected and retaken in the same process — unlike `--judge host`, which leaves the
run open for `pixelproof retake` — so each such retake spends one generation **and** one judge
call, both paid, against the same `--retakes` bound.

> **The artifact appears at `--out` only when the run is accepted.** Under `--judge`, the
> generator writes into the run directory and promotes the file on acceptance. A rejected or
> abandoned run therefore leaves **no file at `--out`** — which is the mechanical form of "an
> unanswered checklist is not a pass". The candidate is still on disk in the run directory
> and is named in the report. This is the one place `--judge host` and bare `generate`
> deliberately differ.

| Command | Purpose |
| --- | --- |
| `pixelproof judge pending [--json]` | Open judgements with age, deadline and expiry. Exits `2` while any exist, so it works as a CI or pre-commit gate. |
| `pixelproof judge show --run <id> [--request]` | Print the checklist; `--request` prints the bare protocol-1 request a judge can consume verbatim. |
| `pixelproof judge submit [--run <id>] [--results <path>\|-] [--interactive]` | Record verdicts and finalise. `--interactive` prompts per check and refuses when stdin is not a terminal. |
| `pixelproof judge abandon --run <id> --reason "<why>"` | Close a run as rejected, on the record — a pending one, or one left open between retake attempts. |

`--run` may be omitted only when exactly one run is pending; two or more is refused naming
each candidate, because a run that cannot prove which record is its own does not get to
guess.

**Identity is proven, not inferred.** Each pending record carries a single-use 32-byte
nonce, and a submission must echo `runId`, `nonce` and `checksDigest`. Digests alone cannot
do this: two concurrent runs of the same spec over the same image compute identical digests,
so only possession of the nonce shows the submitter read *this* pending record. A submission
is refused with a named reason — `PENDING_NONCE_MISMATCH`, `PENDING_CHECKS_MISMATCH`,
`PENDING_EXPIRED`, `ARTIFACT_CHANGED` and five more — recorded in `run.json` and printed by
the report.

An `unsure` verdict escalates once **per attempt**: a second round re-asks only the unsure
assertions with `unsure` resolving to `fail`, and the round-2 verdict *replaces* the round-1
one rather than joining it. There is no third round for an attempt, so a genuinely ambiguous
assertion terminates in `fail`. Round numbers run across the whole run rather than restarting,
so a retaken run's second attempt begins at round 3.

Evidence lives in `.pixelproof/runs/<run id>/` — `run.json`, the attempt and its mechanical
table, `judge-request-<round>.json`, `judge-result-<round>.json`, `report.json` and
`report.md`. Override the location with `--run-dir` or `PIXELPROOF_RUN_ROOT` so CI can put it
on a retained path. Deadlines default to 24 hours and are set with `--judge-deadline 6h`
(a unit is required — a bare number is refused rather than guessed at). Nothing is swept:
an abandoned run directory is retained, because the evidence is the point.

Every `--judge` value — `host`, `codex`, or a comma-separated panel naming more than one —
needs a `.png` target and a spec with at least one `semantic` entry, and refuses both up front
rather than after spending a generation.

### `pixelproof retake`

Spend another attempt on a run that a judged rejection left open under `--judge host`.
`--retakes` bounds the total attempts inside one judged run (`--retakes <n>`, else
`spec.retakes`, else 1). It needs `--judge`: without one, `generate` makes exactly one
provider call and honouring the bound would only change what that call costs.

A **mechanical** failure with the bound unspent is always corrected and regenerated by
`generate` itself, in the same process — no host is involved, so nothing has to wait. A
**semantic** rejection depends on which judge answered: under `--judge host` the two verdicts
arrive in different processes, so `judge submit` records them, leaves the run `running`, and
prints the exact command rather than starting a paid call nobody authorised. Under
`--judge codex`, the verdict already arrived in the process that could act on it, so `generate`
retakes it there and the run never sits open — `pixelproof retake` refuses a subprocess-judged
run by name, naming `judge abandon` and a fresh `generate` as the way to continue one that was
interrupted.

```sh
pixelproof retake --run <id> [--run-dir <path>] [--judge-deadline <dur>]
```

The prompt, spec, provider, size and output all come from the run record; the correction is
assembled from what the rejected attempt actually recorded — a failed mechanical check
contributes its name, expected and measured value, and a failed or unsure semantic assertion
contributes the assertion and the judge's own evidence, verbatim. Where a host recorded no
evidence, the correction says so rather than inventing a reason. The retake is a new numbered
attempt inside the same run directory (`attempt-2.png` beside `attempt-2.json`), not a new
run, and attempt 1's bytes, mechanical table, verdicts and round files are untouched by it.

It exits `1` on rejection or refusal — a terminal run, an outstanding judgement, a run that
asked for no judge, or a spent bound — and `2` when a new checklist is outstanding. There is
no `0`, because acceptance is `judge submit`'s to grant.

**Nothing is promoted on exhaustion.** When the bound is spent and no attempt was accepted, the
run finalises rejected, `--out` stays empty, and the report lists every attempt with its
mechanical table and verdicts so an operator can choose one by hand — there is no ranking
function to appeal to, since scoring is unbuilt, and "best" would silently mean "last".

A run left open between attempts has nothing pending, so `judge pending` does not list it.
`doctor`'s `judgements:` line counts it, and `judge abandon` closes it on the record without
discarding any verdict already submitted.

`--retakes > 1` is refused with the `svg` provider: a retake is a corrected prompt, and the svg
provider is handed markup, so a second attempt would reproduce the first byte for byte.

### The script form

Generate a raster and automatically run its mechanical spec:

```sh
node scripts/generate.mjs --prompt "A ceramic desk lamp on seamless white" --out output/lamp.png --size 1254x1254 --spec specs/product-hero.example.json
```

Validate an image directly, with readable or JSON output:

```sh
node scripts/verify.mjs --file output/lamp.png --spec specs/product-hero.example.json
node scripts/verify.mjs --file output/lamp.png --spec specs/product-hero.example.json --json
node scripts/verify.mjs --file output/lamp.png --spec specs/product-hero.example.json --strict
```

Without `--strict`, skipped checks are called out in the headline but do not change an
otherwise successful exit code. Use `--strict` in CI or other gates to make any skipped check
fail verification with exit code 1. JSON results include the passed, failed, and skipped
counts together with `strict` and the final `ok` boolean.

Validate and write SVG, or rasterise it when `sharp` is available:

```sh
node scripts/generate.mjs --provider svg --svg-file artwork/icon.svg --out output/icon.svg
node scripts/generate.mjs --provider svg --svg-file artwork/icon.svg --out output/icon.png --size 512x512
```

When no `--size` or spec dimensions are supplied, raster generation uses 1024x1024. Codex
model and effort flags are omitted unless their environment variables are set, so the user's
own Codex configuration remains authoritative.

When `--size` is supplied without `--spec`, Pixelproof synthesises width and height checks,
prints the mechanical verification table, and exits non-zero if the generated PNG has different
dimensions. With both options, the spec dimensions are authoritative; a disagreement prints a
warning naming both sizes. Size-only Codex requests are rejected before generation unless both
edges are multiples of 16, neither edge exceeds 3840 pixels, the long-to-short ratio is at most
3:1, and the total pixel count is between 655,360 and 8,294,400 inclusive.

Run the test suite on Node.js 22 or newer with:

```sh
npm test
```

The suite runs test files serially because these are process-spawning integration tests. On
Windows, a run normally takes about one minute; that runtime is expected and is not a hang.

## Requirements

- Node.js 22 or newer.
- Codex CLI installed, logged in, and on `PATH` for raster generation.
- `sharp` is optional. Install dependencies with `npm install` to enable colour, alpha, and
  SVG rasterisation. Without it, PNG dimensions still work through the built-in header parser
  and unavailable checks are clearly marked `SKIP`.

There are no required npm dependencies and no API key is needed.

## Known limitations

Claude has no image-generation model. It can author SVG and visually review image files, but
raster generation in Pixelproof is Codex's built-in image generation, not Claude's. Image
models are nondeterministic: retries can fix one defect while introducing another, exact
colours are not guaranteed, and the bounded loop can finish without a fully passing attempt.
Without `sharp`, colour and alpha checks and SVG-to-PNG rasterisation are unavailable; the CLI
degrades explicitly rather than pretending those checks ran.

Session-directory recovery scans all PNGs under `$CODEX_HOME/generated_images/` that were
created after the run began. Codex output is unstructured and retained only as a bounded tail,
so Pixelproof cannot reliably identify the current session directory. When that scan finds more
than one post-start image, the run cannot prove which is its own and fails with an
`Ambiguous image recovery` error naming every candidate; no file is moved or deleted. This
prevents parallel runs sharing a `CODEX_HOME` from recovering each other's images — it does not
make them work. Two runs in flight against one `CODEX_HOME` will both fail whenever they fall
back to recovery, which is the intended trade: a failure is retryable, a wrongly adopted image
that has passed verification is not detectable at all. Run them sequentially.
