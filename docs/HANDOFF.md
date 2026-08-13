# Pixelproof — session handoff

Written 2026-08-13. Read this, then `docs/adr/README.md`. **The files are the memory, not the
chat history.**

---

## 1. Where things stand

| | |
| --- | --- |
| Repo | `C:\Users\User\Desktop\github\pixelproof` → `github.com/mohamedzhioua/pixelproof` (public) |
| Released | **v0.2.1** — Phase 1 Foundations plus its two debts |
| `main` | `010945d`, clean, one branch, one worktree |
| Tests | **244**, zero fail, **zero todo** |
| CI | **12/12** — Node 22+24 × ubuntu/macos/windows × `sharp` present/absent |
| Unreleased on `main` | Phase 2 Evidence slices (below) |

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

## 3. Phase 2 (Evidence release) — what is done and what is not

**Merged to `main`, but NOT wired into any CLI command:**

- `core/run/` — run directories, `run.json` state machine, `report.json`/`report.md`, ADR 0014
- `judges/codex.mjs` — the first subprocess judge, proven against the real CLI
- `core/heuristics/` — pHash, CIEDE2000 palette distance, blank-frame detection

**Therefore Phase 2 cannot be released as-is.** A user upgrading today gets internals and no new
capability. Everything above is reachable only from tests.

**The next slice is the host handoff — ADR 0009, accepted, foundation already merged.** Build:

- `judge` command with sub-verbs `pending | show | submit | abandon`
- `--judge <name>` and `--judge-deadline` on `generate` and `verify`
- the 32-byte single-use nonce and the nine named refusal reasons
- **exit code 2 = `PENDING_JUDGEMENT`**, which is never a pass
- promotion-to-`--out` only on acceptance
- rewrite `skills/image/SKILL.md` step 6 around the two-step flow (it still says "use Claude
  Code's Read tool", which is host-specific)

Read ADR 0009 in full first. It names the commands, the files, the exit codes and the identity
mechanism; it is a decision, not a sketch.

## 4. Open decisions — maintainer's, not yours to take silently

1. **ADR 0013 should probably be split.** Its colour-science half is implemented and validated
   against all 34 Sharma/Wu/Dalal reference pairs; its pHash corpus, ICC handling and
   alpha-compositing background are genuinely unresolved. One document means the validated half
   stays `Deferred` over an unrelated question. Status deliberately left alone.
2. **The duplicate threshold needs real generated output.** `findDuplicates` throws without an
   explicit `maxDistance`, on purpose. The synthetic corpus separates same from different by 4
   bits of 64 but omits the hard case — several attempts at one prompt, different but sharing
   composition and palette. `docs/evidence/heuristic-calibration.md` records what a maintainer
   could defensibly start from.
3. **A single foreign recovery candidate is still adopted** (ADR 0008). Timestamps cannot prove
   whose an image is. Closing it needs positive identity — a run-owned output location or a
   session id Codex reports back. Isolating `CODEX_HOME` per run does **not** work: Codex keeps
   credentials there.
4. **Degraded SVG semantics** (ADR 0019) must be decided again when the contract path becomes the
   CLI's engine. Three options are named there.

## 5. Model routing — maintainer's standing instruction (2026-08-13)

- **Sonnet** for anything high-volume or usage-draining: broad file sweeps, mechanical edits,
  docs passes, repetitive test authoring, log trawling.
- **Opus** for the hard parts: protocol and contract design, anything touching acceptance or
  provenance, cross-platform debugging, adversarial review, ADRs.

Codex is **not** the executor lane as of 2026-08-13, and the Codex account hit its usage limit
until 2026-08-18 regardless.

## 6. Traps this project has already paid for

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
Prefer tests that would fail if the mechanism were removed, and prove new guards bite by
temporarily reintroducing the violation.

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

## 7. How work lands here

Branch → PR → CI green on the PR → merge → land-verify post-merge → tag → release from the tag.
Never tag a commit whose CI you have not observed; v0.1.0 was released red that way. Releases are
`gh release create <tag> --notes-file` with notes extracted from `CHANGELOG.md`.

## 8. The standard that has held

Refusing to ship is a valid, and sometimes the correct, outcome. Two Phase 2 examples worth
imitating: text-likelihood detection was **measured and refused** because a heading on flat
artwork scores indistinguishably from an empty frame, so a "no text" assertion would be marked
satisfied with text plainly visible; and a duplicate threshold was refused because the corpus
that would justify it does not exist yet. Both refusals are recorded with their evidence.
