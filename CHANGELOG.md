# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed

- Session-directory recovery guessed when it could not prove ownership: it adopted the newest
  post-start PNG under `$CODEX_HOME/generated_images`, so two runs sharing a `CODEX_HOME` could
  each adopt the other's image and report success on an asset they never generated — a silent
  wrong result. Recovery now rejects an ambiguous scan: more than one post-start candidate fails
  the run with an `Ambiguous image recovery` error naming every candidate and its mtime, and no
  file is moved, adopted, or deleted. This eliminates cross-run adoption; it does not make
  concurrent runs sharing a `CODEX_HOME` work — both now fail instead of one succeeding wrongly.
  Runs with a provable answer (a directly written target, exactly one candidate, or none) are
  unchanged, as are all flags, output and exit codes.

## [0.2.0] - 2026-08-13

### Added

- A `pixelproof` executable grouping `generate`, `verify` and `doctor`. It is a synonym for the
  existing `scripts/*.mjs` entry points — same handlers, same process, identical flags, output
  and exit codes — not a second dialect.
- `pixelproof doctor`, a read-only environment report: which providers are installed, their
  declared limits, and which mechanical checks will run versus `SKIP`. It never invokes a
  provider and never probes authentication, so it spends no quota; credentials it cannot cheaply
  prove are reported as `unknown / not safely probeable` rather than guessed at.
- Internal architecture for v2: provider and judge protocols with a closed error taxonomy, a
  generic adapter subprocess runtime that terminates process trees on timeout, vendor-neutral
  verification and generation cores, and filesystem-derived artifact provenance. None of it
  changes any documented v1 behaviour; it is the seam later phases build on.

### Fixed

- Freshness was decided by comparing two different clocks: the run start came from `Date.now()`
  while an artifact's age came from its filesystem mtime. On Linux, where inode timestamps are
  stamped from a coarse, tick-granular clock that lags the fine-grained one, a file written after
  the run began could carry an earlier mtime and be rejected as stale — failing a run that had in
  fact succeeded. The run start is now sampled from the same filesystem that stamps the artifact,
  and the Codex recovery scan samples `$CODEX_HOME/generated_images` separately because it may
  live on another mount.

## [0.1.2] - 2026-08-13

### Fixed

- A pre-existing file at the output path was accepted as a successful generation because the
  post-run check tested existence rather than freshness, so a failed run could report success
  on stale content.

## [0.1.1] - 2026-08-13

### Fixed

- The verify CLI test depended on an untracked file under the gitignored
  `.pixelproof-scratch/` directory, so it passed locally and failed on a clean checkout; the
  test now builds its own fixture.

## [0.1.0] - 2026-08-12

### Added

- A Node.js 22 or newer runtime requirement.
- A Claude Code plugin exposing the `image`, `vector`, and `spec` skills.
- Raster generation through the Codex CLI's built-in `image_gen` tool using ChatGPT
  credentials, with no API key required.
- A Claude-authored SVG path for diagrams, icons, logos, and charts, with optional `sharp`
  rasterisation.
- Two-tier verification: mechanical checks in code for dimensions, aspect ratio, four-corner
  colour sampling with per-channel tolerance, alpha, and maximum bytes; plus semantic review
  where Claude reads the image and judges the spec criteria.
- `--strict` mode, which makes skipped checks fail the run, and `--json` output containing
  `passed`, `failed`, `skipped`, `strict`, and `ok` fields for machine consumers.
- Recovery from Codex's per-session `$CODEX_HOME/generated_images/<session-uuid>/` output
  directories, guarded so only images created after the run began are adopted.
- Verified `--size` requests, including rejection of impossible sizes before Codex is invoked.
- A bounded retake loop driven by the `image` skill and capped by `spec.retakes`.
- Graceful degradation when optional `sharp` is unavailable.

### Known limitations

Claude has no image model, so raster generation is Codex's responsibility. Image models are
nondeterministic and do not always honour a requested size, so Pixelproof verifies generation
results instead of trusting the request.
