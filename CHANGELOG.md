# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.5.0] - 2026-08-14

### Added

- **`--judge codex` on `generate` and `verify`** (ADR 0021). A judge registry
  (`core/judge/registry.mjs`) separate from the provider registry — `codex` is now both a
  provider and a judge, one vendor in two roles with two id namespaces — resolves the request
  and runs Codex CLI as a judge **synchronously, in the same process**. The run never enters
  `pending-judgement` and never exits 2: exit 0 is acceptance with promotion to `--out` under
  the unchanged ADR 0009 §2 rule, exit 1 is rejection, an error, or an unresolvable `unsure`.
  Only bundled judges are supported; an external judge is refused, and `host` is refused as a
  judge id because it names a run state, not a registry entry.
- `validateJudgeManifest()` in `core/contracts/judge.mjs`, which validates a judge's declared
  capabilities and **refuses** an unknown key rather than the provider validator's drop-and-fabricate
  behaviour — a judge manifest describes a different shape than a provider's generation
  geometry, and reusing `validateManifest()` would hand `doctor` a report that lies about what a
  judge can do.
- `judge.kind` in `run.json` widens from `{ "const": "host" }` to the open enum
  `host | subprocess | mixed`, and an additive `judge.panel[]` array records who judged. The
  envelope stays `pixelproof.run/1`: the field keeps its name and type, and a test pins the
  three legal values so a fourth cannot arrive unnoticed.
- With no `host` in the panel, an `unsure` verdict that would otherwise escalate is instead
  **rejected** as `semantic-unsure`, naming the missing escalation authority and telling the
  operator to add `,host` to `--judge`. Re-asking the same subprocess judge is not escalation —
  it is the same authority answering the same question a second time, which would convert "I
  cannot tell" into a coin flip that reports as a verdict.
- A semantic rejection from a subprocess judge with the retake bound unspent is corrected and
  retaken **in the same process** (unlike the host path, which leaves the run open and prints
  `pixelproof retake`): the verdict already arrived in the process that could act on it. Each
  such retake spends one generation and one judge call, both paid, against the same `--retakes`
  bound. `pixelproof retake` refuses a subprocess-judged run by name, naming `judge abandon` and
  a fresh `generate` as the way to continue one that was interrupted.
- `--judge-deadline` is refused with a subprocess-only panel: nothing stays outstanding to have
  a deadline. The subprocess bound is `PIXELPROOF_JUDGE_TIMEOUT_MS` (default 300000 ms),
  already implemented in `judges/codex.mjs`.
- `pixelproof doctor` reports judges the same way it reports providers: bounded import, bounded
  `detect`, and availability is not authentication (ADR 0016) — `codex` on `PATH` reports
  available with `auth: unknown`, and nothing shells out to prove otherwise.
- `generate --help` and `verify --help` gain a `Subprocess judgement:` section alongside the
  existing `Host judgement:` one.

### Not built in this slice, by decision at the gate

- **A mixed panel** (`--judge codex,host`). ADR 0009 §5 already specifies its rules and this
  slice changes none of them, but building it multiplies the state surface it touches —
  subprocess-then-pending, an escalation authority present again, and an in-process retake
  crossing a handoff that by definition cannot complete in-process — and none of it could be
  proven against the real vendor before quota returns anyway. A `--judge` value naming more
  than one judge is refused by name rather than silently reduced to its first entry.
- **The wired path has been proven only against a fake Codex CLI.** `judges/codex.mjs` itself
  was verified against codex-cli 0.147.0 in isolation before this slice; the generate → judge →
  promote path this slice wires has run only against the hermetic fake-CLI seam
  (`test/judge-codex-run.test.mjs`, `test/judge-registry.test.mjs`), because the Codex account
  is over quota until 2026-08-18. No end-to-end run against the real vendor has happened yet,
  and nothing here claims otherwise.
- Scoring, external judges, and a `claude` or `gemini` judge remain unbuilt, as before.

## [0.4.0] - 2026-08-14

### Added

- **Retakes under a judged run** (ADR 0020). A retake is a new numbered attempt **inside the
  same run directory** — `attempt-2.png` beside `attempt-2.json` — not a new run and not a
  chain of linked runs. Attempt *n*'s bytes, mechanical table, verdicts and round files are
  immutable once written; attempt *n+1* occupies a new slot and touches none of them.
- `--retakes <n>` on `generate`, bounding the total attempts inside one judged run. The bound
  is `--retakes`, else `spec.retakes`, else **1**. It is honoured **only** with `--judge`:
  without one, `generate` still makes exactly one provider call, `--retakes` is refused, and
  `spec.retakes` is not read at all. `spec.retakes` has been declared in the example spec and
  documented since v0.1.0 but was read by no code; honouring it unconditionally now would
  silently triple what every existing caller with a spec spends.
- `pixelproof retake --run <id> [--run-dir <path>] [--judge-deadline <dur>]`, a new top-level
  command. The prompt, spec, provider, size and output come from the run record. It refuses,
  with exit 1 and a named reason, a run that is terminal, has an outstanding judgement, asked
  for no judge, or has spent its bound — adding exactly two codes to ADR 0009 §3's closed set,
  `RETAKE_EXHAUSTED` and `RETAKE_NOT_OPEN`, and reusing the four id and envelope refusals
  unchanged.
- **Corrections are assembled from recorded evidence, never invented.** A failed mechanical
  check contributes its name, expected value and measured value; a failed or unsure semantic
  assertion contributes the assertion verbatim and the host's own `evidence` string verbatim.
  Where a host recorded no evidence, the block says so rather than inventing a reason.
- **`report.json` and `report.md` now carry each attempt's mechanical table and its recorded
  verdicts**, not only its three counts. ADR 0020 §7 tells an operator to choose an attempt by
  hand on exhaustion, and three integers describe no artifact anyone can choose between; the rows
  and verdicts previously existed only in `attempt-<n>.json`, which ADR 0014 §1 calls internal
  evidence that ships no schema. Both keys are additive to `pixelproof.report/1` and are `null`
  rather than absent when there is nothing to say. An attempt whose evidence file is missing or
  corrupt is listed with `evidenceUnreadable` rather than omitted, and never blocks finalisation.
- A **mechanical** failure with the bound unspent is corrected and regenerated in the same
  process, because no host is involved and nothing has to wait. A **semantic** rejection is
  handled the other way round: `judge submit` records the verdicts, leaves the run open, prints
  the correction and the exact retake command, and **exits 1**. It never generates, so
  `judge submit --interactive` on a human's terminal still cannot start a paid call.

### Changed

- `pending-judgement -> running` is now a legal transition (ADR 0020 §1), taken only by the
  finalisation logic that is starting a new attempt number while the bound is unspent. The
  state *set* is unchanged, so there is no `pixelproof.run/2` bump and no consumer that
  switches exhaustively on `state` breaks. **`accepted -> running` stays refused**, which is
  what keeps ADR 0009's nonce single-use.
- **`running` now carries a second meaning for a consumer:** not only "no attempt has finished
  yet" but also "an attempt was rejected and the next one has not started". `accepted` stays
  `null` in both — the run has not decided — and the difference is legible from `attempts[]`
  and from the rejection already in `reasons[]`. A consumer that read `running` as "nothing has
  been judged yet" is now wrong.
- **A run can end in `running`** if an operator never retakes and never abandons. Nothing is
  pending on it, so `judge pending` correctly does not list it; `doctor`'s `judgements:` line
  counts it instead (`N runs open between attempts`), and `judge abandon` now reaches it so it
  can be closed on the record. No verdict is discarded by that close: verdicts are written
  before the run ever leaves `pending-judgement`. Such a run is identified by the
  `retake-available` reason its rejection recorded, **not** by "`running` with an attempt" — that
  looser reading also matches a healthy generation between two attempts.
- `judge abandon` with `--run` omitted now considers open-between-attempts runs alongside pending
  ones. With one of each it refuses and names both, where it previously closed the pending one: a
  command that cannot prove which run is meant does not get to guess.
- Round numbers run across the whole run rather than restarting per attempt, so attempt 2
  begins at round 3 and `judge-request-<round>.json` stays unique in one directory. ADR 0009
  §5's bound of two rounds is unchanged and is now explicitly **per attempt**; `rounds[]` and
  the pending record both record which attempt a round judges.
- `skills/image/SKILL.md` no longer runs a prose retake loop of its own bounded at 3, and no
  longer copies a "best attempt" to the requested output on exhaustion. **Nothing is promoted
  on exhaustion**: the run finalises rejected, `--out` stays empty, and the report lists every
  attempt so an operator can choose one by hand. A file at `--out` is the signal that the spec
  was satisfied, a labelled exception is a label a build script does not read, and there is no
  ranking function to appeal to because scoring is unbuilt — "best" would silently mean "last".

## [0.3.0] - 2026-08-14

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
