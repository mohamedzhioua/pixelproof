# Pixelproof — session handoff

Written 2026-08-13. Read this, then `docs/adr/README.md`. **The files are the memory, not the
chat history.**

---

## 1. Where things stand

| | |
| --- | --- |
| Repo | `C:\Users\User\Desktop\github\pixelproof` → `github.com/mohamedzhioua/pixelproof` (public) |
| Released | **v0.2.1** — Phase 1 Foundations plus its two debts |
| Branch | `feat/host-judge-handoff`, pushed, PR open against `main` |
| `main` | `294d3c4`, clean |
| Tests | **279**, zero fail, **zero todo** (244 before this slice) |
| Unreleased on `main` | Phase 2 Evidence internals |
| Unreleased on the branch | ADR 0009, the host judge handoff — the first Phase 2 work reachable from the CLI |

`npm test` runs serially on purpose (`--test-concurrency=1`) and takes roughly 1–2 minutes.
That is expected, not a hang.

## 2. What the product is

Claude Code has no raster image model; Codex CLI generates images through the user's ChatGPT
subscription with **no API key**. So: **Codex is the camera, Claude is the art director and the
reviewer.** The differentiator is not generation — it is that an artifact is only accepted if it
satisfies a written spec, checked by two independent tiers:

- **Mechanical** — code only, deterministic, free: dimensions, aspect, four-corner colour with a
  per-channel tolerance, alpha, max bytes.
- **Semantic** — a vision model reads the image back and judges written assertions.

Colour assertions carry a tolerance because generative models never deliver exact values: three
measured runs put a requested pure white at `#FEFDFD`, `#FEFEFE`, `#FFFEFD`. A zero-tolerance
check would reject every otherwise-correct image forever.

## 3. What this slice built (ADR 0009), and what it deliberately did not

**Built, on `feat/host-judge-handoff`:**

- `core/judge/` — the handoff mechanism: the nine `PENDING_*` refusals, the 32-byte single-use
  nonce, `checksDigest`/`specDigest`, deadline parsing, the pending and result envelopes, the
  submit checks, and the issue/apply/close/promote policy. It imports nothing outside `core/`.
- `pixelproof judge` with `pending | show | submit | abandon`, the sub-verb peeled before flag
  parsing.
- `--judge host`, `--judge-deadline` and `--run-dir` on `generate` and `verify`.
- **Exit code 2 = `PENDING_JUDGEMENT`**, verified through the real binary, not a returned number.
- Promotion to `--out` only on acceptance.
- Escalation round 2 (unsure-only, `onUnsure` forced to `fail`, verdict *replaces* rather than
  joins), bounded at two rounds.
- `doctor` gains `judgements: N pending host judgements (M expired)`.
- `schema/judge-pending.v1.json`, `schema/judge-result.v1.json`, and the real `judge`/`rounds`
  shapes in `schema/run.v1.json` (they were documented as "not written by this phase").
- `skills/image/SKILL.md` step 6 rewritten host-neutral around the two-step flow.

**Deliberately not built** — decided with the maintainer on 2026-08-13, not an oversight:

1. **Subprocess judges are not wired.** `--judge codex` is refused with a named error. There is
   no judge registry: `core/adapters/discover.mjs` is provider-shaped (it validates a provider
   manifest and demands a `generate` function), so building one is new surface ADR 0009 does not
   specify. ADR 0009 §5's mixed panel needs it. And the Codex account is over quota until
   **2026-08-18**, so a wired subprocess judge could not have been proven end to end this week.
2. **A mechanical failure under `--judge host` rejects immediately and writes no checklist.**
   Both tiers are hard gates (ADR 0011), so spending a host round on an already-rejected
   artifact could only produce the confusing case where every assertion passes and the run is
   still rejected. Exit 1, not 2.
3. **`--judge host` requires a `.png` target and a spec with at least one `semantic` entry**,
   both refused before a provider is invoked. Degrading a vector target to `SKIP` would report
   an unverified image as verified, and ADR 0019 has not been re-decided yet (§5 below).

## 4. Open decisions — maintainer's, not yours to take silently

1. **The v1 banners do not mention `--judge`.** ADR 0003 freezes v1 prose ("may change only
   where it reports a newly detected safety failure") and ADR 0009 promises byte-identical
   behaviour without `--judge`, `--help` included. So `generate --help` and `verify --help` are
   unchanged and a test asserts they stay that way. `--judge` is documented on new surface
   instead: the top-level banner, `pixelproof judge --help`, `doctor`, and the README. Listing it
   in the frozen banners needs an amendment to ADR 0003. **This is the most likely thing a user
   will trip over.**
2. **ADR 0013 should probably be split.** Its colour-science half is implemented and validated
   against all 34 Sharma/Wu/Dalal reference pairs; its pHash corpus, ICC handling and
   alpha-compositing background are genuinely unresolved. One document means the validated half
   stays `Deferred` over an unrelated question. Status deliberately left alone.
3. **The duplicate threshold needs real generated output.** `findDuplicates` throws without an
   explicit `maxDistance`, on purpose. `docs/evidence/heuristic-calibration.md` records what a
   maintainer could defensibly start from.
4. **A single foreign recovery candidate is still adopted** (ADR 0008). Timestamps cannot prove
   whose an image is. Note that ADR 0009 *did* close the equivalent hole for the handoff, and the
   answer was the same shape: positive identity (a nonce), not a stricter reading of the same
   evidence. Closing 0008 needs a run-owned output location or a session id Codex reports back.
   Isolating `CODEX_HOME` per run does **not** work: Codex keeps credentials there.
5. **Degraded SVG semantics** (ADR 0019) must be decided again when the contract path becomes the
   CLI's engine. `--judge host` currently refuses a non-PNG target rather than pre-empting it.

## 5. What is worth doing next

In rough order of value:

1. **Retakes under a judged run.** The run directory and `attempts[]` already model several
   attempts; nothing yet produces a second one. This is the missing half of the loop the image
   skill describes in prose.
2. **The judge registry and `--judge codex`**, once quota returns — with ADR 0009 §5's mixed
   panel and `combineVerdicts` at submit time over the full panel.
3. **A release.** Phase 2 now has a user-visible capability for the first time, so a `0.3.0` is
   defensible in a way it was not before this slice.

## 6. Model routing — maintainer's standing instruction (2026-08-13)

- **Sonnet** for anything high-volume or usage-draining: broad file sweeps, mechanical edits,
  docs passes, repetitive test authoring, log trawling.
- **Opus** for the hard parts: protocol and contract design, anything touching acceptance or
  provenance, cross-platform debugging, adversarial review, ADRs.

Codex is **not** the executor lane as of 2026-08-13, and the Codex account hit its usage limit
until 2026-08-18 regardless.

## 7. Traps this project has already paid for

Every one of these shipped or nearly shipped. Do not relearn them.

**A green local suite proves almost nothing about other platforms.** The suite was green on
Windows, on clean clones, and in both dependency lanes at every step, and CI still caught three
real product bugs this box structurally cannot reproduce:

- a Linux **coarse-clock** freshness bug that falsely rejected freshly generated images
  (`Date.now()` vs inode mtime — fixed by `runReference()`, a marker file on the same filesystem)
- a **CRLF shebang** shipping a broken `bin` (a shebang followed by CR is not a shebang; fixed by
  `.gitattributes eol=lf`)
- an **`unref`'d timeout** making `doctor` print nothing on Node 22 against a hung probe

**Tests that pass for the wrong reason are the recurring defect.** Found and fixed: a
grandchild-termination test that passed with no tree-kill at all; a macOS `<TMP>` token matching
only the tail of a symlinked path; `ERR_MODULE_NOT_FOUND` masquerading as "sharp is missing".
Prefer tests that would fail if the mechanism were removed. Where a guard cannot safely be
removed to prove it bites — deliberately disabling the nonce check is the obvious example — get
the same discrimination *inside one test*: submit the identical payload twice, changing only the
field under test, and assert the opposite outcomes. `test/judge-handoff.test.mjs` does this.

**Every judged test must pass `--run-dir`.** A test that writes into the repository's own
`.pixelproof/` leaves state for the next one, and an assertion about the checkout's cleanliness
fails for reasons that have nothing to do with the code. Run the plain path from a temporary
working directory rather than asserting about `repositoryRoot`.

**Verify by reading the output, not the exit code.** A Python heredoc silently did nothing here
because Python is not installed; the exit code was fine and the patch was never applied.
Similarly `-a`, `--search` and `isolation: "worktree"` all did something other than their names
implied.

**Before releasing: prove it on a fresh `git clone` + `npm ci`, in both lanes.** The working tree
lies — v0.1.0 went red because a test read a fixture from the gitignored `.pixelproof-scratch/`.

**Codex CLI specifics.** `codex exec` needs `--skip-git-repo-check` and a closed stdin or it
refuses/hangs. Verify flags against the installed CLI's own `--help`; two were once assumed from
the wrong help page and both failed. Its `image_gen` needs no API key. Session dirs from
`codex exec` hold exactly one image; the 47-image dirs are interactive sessions.

**Delegation.** Give each agent its **own `git worktree` inside this repo** —
`git worktree add ../pixelproof-wt-<name> -b feat/<name> main`. "Separate branches" in one
working directory is not isolation, and the harness's `isolation: "worktree"` builds a worktree
of the *session's* repo, which may be a different project entirely. State the absolute target
path in the brief and tell the agent to stop rather than improvise if it is not there.

## 8. How work lands here

Branch → PR → CI green on the PR → merge → land-verify post-merge → tag → release from the tag.
Never tag a commit whose CI you have not observed; v0.1.0 was released red that way. Releases are
`gh release create <tag> --notes-file` with notes extracted from `CHANGELOG.md`.

## 9. The standard that has held

Refusing to ship is a valid, and sometimes the correct, outcome. Three examples worth imitating:
text-likelihood detection was **measured and refused** because a heading on flat artwork scores
indistinguishably from an empty frame, so a "no text" assertion would be marked satisfied with
text plainly visible; a duplicate threshold was refused because the corpus that would justify it
does not exist yet; and this slice refused to wire a subprocess judge it could not prove end to
end. Every refusal is recorded with its evidence.
