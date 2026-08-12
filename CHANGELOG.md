# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
