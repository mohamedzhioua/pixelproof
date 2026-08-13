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
> Claude must open the produced image with its Read tool and judge every entry visibly.

When either tier finds a real failure, Claude refines the prompt with the specific violation
and retakes the image. The loop is bounded by `retakes`; failure is reported rather than
accepted or retried forever.

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
`retakes` is the maximum total number of attempts used by the image skill and defaults to 3.

## Standalone CLI

Everything works without Claude. There are two equivalent entry points: `bin/pixelproof.mjs`
groups the commands under one executable, and the original `scripts/*.mjs` paths keep working
unchanged. They share the same handlers in the same process, so they are synonyms rather than
two dialects — identical flags, output and exit codes.

```sh
pixelproof <command> [options]     # generate | verify | doctor
node bin/pixelproof.mjs verify --file lamp.png --spec specs/product-hero.example.json
node scripts/verify.mjs   --file lamp.png --spec specs/product-hero.example.json
```

The package is `private`, so `pixelproof` resolves after `npm link`; in a checkout, run
`node bin/pixelproof.mjs`.

### `pixelproof doctor`

Reports what this machine can actually do, before you spend a generation finding out: which
providers are installed, each one's declared limits, and — the part that causes the most
confusion — **which mechanical checks will run and which will `SKIP`**.

```sh
pixelproof doctor            # human report
pixelproof doctor --json     # the same document, machine-readable
```

It is read-only and never spends quota. It will not invoke a provider to generate anything,
and it deliberately does not probe authentication, because that means a network call that can
hang behind a login prompt. Credentials it cannot cheaply prove are reported as
`unknown / not safely probeable` rather than guessed at — a confident wrong "ready" is the
failure this project exists to prevent, so `doctor` does not produce one about itself.

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
