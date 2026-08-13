# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **The host judge handoff** (ADR 0009). `--judge host` on `generate` and `verify` writes a
  machine-readable checklist, records the artifact and its mechanical result in a run
  directory, and **exits 2** — an outstanding judgement, never a pass. The calling agent then
  opens the artifact with its own vision capability and answers with `pixelproof judge
  submit`. This replaces the shape the brief originally specified, which deadlocked: the only
  entity that can open the image is the agent blocked on the child process, so it could never
  write the file core was waiting for.
- `pixelproof judge` with four sub-verbs: `pending` (open judgements, exits `2` while any
  exist so it works as a CI gate), `show` (the checklist, or `--request` for the bare
  protocol-1 request), `submit` (`--results <path>`, `--results -`, or `--interactive`, which
  refuses a non-TTY rather than hanging a pipeline), and `abandon` (close a run as rejected,
  on the record).
- **Identity by nonce, not by digest.** Each pending record carries a single-use 32-byte
  nonce, and a submission must echo `runId`, `nonce` and `checksDigest`. Two concurrent runs
  of the same spec over the same image compute identical digests, so content cannot say whose
  pending record is whose — the same hole ADR 0008 closed for artifact recovery. Nine named
  refusals (`PENDING_ID_MALFORMED`, `PENDING_FOREIGN_ROOT`, `PENDING_NOT_FOUND`,
  `PENDING_NOT_OPEN`, `PENDING_SCHEMA_UNSUPPORTED`, `PENDING_NONCE_MISMATCH`,
  `PENDING_CHECKS_MISMATCH`, `PENDING_EXPIRED`, `ARTIFACT_CHANGED`) are recorded in `run.json`
  and printed by the report.
- **Promotion on acceptance only.** Under `--judge`, the generator writes into the run
  directory and the artifact appears at `--out` when the run is accepted. A rejected or
  abandoned run leaves no file where a caller would look for one — the mechanical form of "an
  unanswered checklist is not a pass". The candidate stays in the run directory and is named
  in the report.
- **Escalation as a further pending round.** An `unsure` verdict re-asks only the still-unsure
  assertions, with `unsure` forced to resolve as `fail` that round; the round-2 verdict
  *replaces* the round-1 one rather than joining the panel, which is what makes escalation
  resolve anything under the default `all` policy. Rounds are bounded at two.
- Deadlines: `--judge-deadline`, default 24 hours. A unit is required — a bare number is
  refused rather than read as seconds or milliseconds, which differ by a thousandfold.
- `--run-dir` and `PIXELPROOF_RUN_ROOT` to place the run root on a retained path.
- `pixelproof doctor` gains one line — `N pending host judgements (M expired)` — so an
  abandoned handoff is visible to someone who never knew one happened. A failed scan says so
  rather than reporting none.
- `schema/judge-pending.v1.json` and `schema/judge-result.v1.json`, the two envelopes a
  consumer outside this repository reads and writes.
- `pixelproof doctor --run-dir <path>`, so the pending-judgement line can scan a run root that
  is not the working directory's. `doctor` already honoured `PIXELPROOF_RUN_ROOT`; accepting the
  flag under a different name from `generate`, `verify` and `judge` — or not at all — would have
  been the two-dialects problem in miniature.

### Changed

- **ADR 0003 is amended** (2026-08-13): the v1 prose freeze now permits *purely additive* lines
  documenting a new flag in a banner, provided every existing line stays byte-identical. The
  freeze exists to prevent behavioural drift and a help line adds no behaviour, whereas a flag
  whose own command's help does not mention it is undiscoverable by the only route a user would
  try. No existing line may change, and no exit code, JSON field or documented semantic may move.
- `generate --help` and `verify --help` accordingly list `--judge host`, `--judge-deadline` and
  `--run-dir`, and gain a `Host judgement:` section naming exit 2 and the promotion rule. The
  characterization tests were updated deliberately to the new expected banners — they are the
  evidence — and a new check holds every pre-amendment line present, unchanged and in order, so
  pasting in a banner with a silently reworded old line still fails.
- `skills/image/SKILL.md` step 6 is host-neutral: it said "use Claude Code's Read tool", and
  now says to open the artifact with whatever image-reading capability the host has, with the
  two-step `--judge host` flow documented alongside. The same instruction serves the Codex and
  Gemini bundles.
- `pixelproof verify` and `pixelproof doctor` now camel-case dashed option keys, as `generate`
  already did. Every pre-existing flag on both is a single word, so nothing is renamed.

### Unchanged

- Without `--judge`, behaviour is byte-identical: same flags, same output, same exit codes, and
  no run directory is created. `--help` gained lines and lost none.

## [0.2.1] - 2026-08-13

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
