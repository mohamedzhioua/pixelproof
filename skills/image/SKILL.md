---
name: image
description: >-
  Generate or retake raster images, product heroes, illustrations, photos, textures,
  backgrounds, icons, logos, diagrams, and other visual assets with Codex image generation;
  use whenever an image must be rendered and verified against visual or pixel requirements.
---

# Pixelproof image workflow

Treat Codex as the camera and yourself as the art director and reviewer. A file is not
finished merely because generation succeeded: it must pass the mechanical checks that code
can measure and the semantic checks that only visual review can judge.

Use `${CLAUDE_PLUGIN_ROOT}` as the repository root for a plugin installation. If this skill
was copied into `~/.claude/skills/`, use the user's Pixelproof clone path instead (normally
provided as `PIXELPROOF_ROOT`).

## Workflow

1. Resolve the spec before generating. If the user supplied a spec, read it. If no suitable
   spec exists, invoke the `pixelproof:spec` skill (or follow that skill's interview and JSON
   format) and write `specs/<name>.json`. Do not invent consequential product constraints
   when a brief question would resolve them.
2. Decide whether this generation is judged, and by whom. **The retake bound is enforced by
   the tool, not by counting here, and only applies with `--judge`.** Pass `--retakes <n>`, or
   omit it and let the tool read `spec.retakes`, defaulting to a single attempt when neither is
   given. Without `--judge`, `--retakes` is refused and `spec.retakes` is never read at all — a
   bare `generate` makes exactly one provider call regardless of what the spec says. Use
   `--judge host` whenever the spec's `semantic` entries need to be recorded evidence and this
   host is the one reading the image; use `--judge codex` when the Codex CLI itself should read
   and judge the image instead — it runs in the same process and never hands you a checklist to
   answer, so **skip straight to step 7** rather than following **Recording the semantic tier**.
3. Generate the first attempt:

   ```sh
   node "${CLAUDE_PLUGIN_ROOT:-$PIXELPROOF_ROOT}/scripts/generate.mjs" --prompt "<specific prompt>" --out "<asset path>.png" --spec "<spec path>" --judge host
   ```

   A non-zero exit without `--judge` may mean the image was created but failed its automatic
   mechanical gate; inspect the report and the file, do not discard the evidence. Under
   `--judge host`, exit 2 means a checklist was written and no verdict exists yet — go to
   **Recording the semantic tier** below. Under `--judge codex`, there is no checklist: the
   command exits 0 accepted or 1 rejected, and the correction and retake (if any) already
   happened before it returned — go to step 7.
4. Read every row of the mechanical table. `FAIL` is a failed tier. `SKIP` means an optional
   decoder was unavailable: report that criterion as unverified rather than quietly calling it
   a pass, and do not spend a retake on it, because another image cannot repair the
   environment.

   Under `--judge` with the bound unspent, a mechanical failure needs nothing from you: the
   tool corrects the prompt from its own measured values and regenerates the next numbered
   attempt (`attempt-2.png`, `attempt-3.png`, …) **inside the run directory, in the same
   process**. Read the printed correction and carry on.

   Without `--judge` there is one attempt and no automatic retake, so run the tier explicitly
   against the file you were given:

   ```sh
   node "${CLAUDE_PLUGIN_ROOT:-$PIXELPROOF_ROOT}/scripts/verify.mjs" --file "<asset path>.png" --spec "<spec path>"
   ```
5. Judge every entry in `spec.semantic` against the image itself. **Open the produced file
   with whatever image-reading capability this host has** — do not infer semantic success
   from the prompt, the filename, Codex output, or the mechanical report. State each
   criterion verbatim, mark it `pass`, `fail` or `unsure`, and give a short piece of visible
   evidence. `unsure` is a real answer and is never a pass.

   Recording the verdicts through the tool, rather than only in your reply, is the supported
   path — it is what puts them in the run's evidence. See **Recording the semantic tier**
   below.
6. If the checklist comes back rejected and the retake bound is unspent, `judge submit` leaves
   the run open (state `running`) rather than finalising it, and prints the exact next command.
   Continue with it:

   ```sh
   pixelproof retake --run <id>
   ```

   This reads the prompt, spec, provider and output back from the run record, assembles the
   correction from that attempt's own recorded evidence — never invented — and regenerates a
   new numbered attempt in the same run directory. Return to step 5 and judge it.
7. Stop when the run is accepted, when a new checklist is pending, or when the retake bound is
   spent. **Nothing is promoted on exhaustion**: a run that spends its bound without an
   accepted attempt finalises rejected, `--out` stays empty, and the run's report lists every
   attempt with its mechanical table and verdicts. Read the report and choose by hand — there
   is no ranking function the tool can appeal to, so it never picks a "best" attempt for you.

## Recording the semantic tier

This section is for `--judge host` only. `--judge codex` does not use it: the Codex CLI reads
and judges the image itself, in the same process as `generate`, so there is no checklist for
this host to answer and no second command to run.

`--judge host` turns step 5 into two invocations that never block on each other. This exists
because the blocking shape is impossible: the agent that ran `generate` is the only entity
that can open the image, and while it waits on the child process it cannot read anything.

```sh
pixelproof generate --prompt "<prompt>" --out output/hero.png --spec specs/hero.json --judge host
# exit 2 — a checklist was written and no verdict exists yet
```

Then:

1. Read `judge-request-<round>.json` in the run directory the command names — round 1 on a
   first attempt, and a higher number on an escalation or a retake, since round numbers run
   across the whole run — or run `pixelproof judge show --run <id>` to print the open
   checklist again.
2. Open the artifact it points at with this host's image-reading capability and judge each
   assertion.
3. Write the verdicts and submit them. Echo `runId`, `nonce` and `checksDigest` back exactly
   as the pending record gives them — the nonce is what proves the verdicts belong to *this*
   run, and two runs of the same spec over the same image are otherwise indistinguishable:

   ```json
   {
     "runId": "<from judge-request-1.json>",
     "nonce": "<from judge-request-1.json>",
     "checksDigest": "<from judge-request-1.json>",
     "response": {
       "protocol": 1,
       "ok": true,
       "judge": "host",
       "results": [
         { "id": "s-1f4a2b3c9d", "verdict": "pass", "evidence": "what you actually saw" }
       ]
     }
   }
   ```

   ```sh
   pixelproof judge submit --run <id> --results verdicts.json
   ```

Rules that are enforced, not advisory:

- **Exit 2 is never a pass.** It means an outstanding judgement. `pixelproof judge pending`
  also exits 2 while anything is open, so it works as a gate.
- **Answer exactly the checks you were asked**, one result per check. A missing or extra
  result is rejected rather than treated as complete.
- **`unsure` escalates once.** A second round re-asks only the unsure assertions, with
  `unsure` resolving to `fail` that time. There is no third round.
- **Nothing appears at `--out` until the run is accepted.** A rejected or abandoned run
  leaves no file where the caller would look for one; the candidate stays in the run
  directory, named in the report.
- If you cannot answer, close the run on the record with
  `pixelproof judge abandon --run <id> --reason "<why>"`. Leaving it open is not neutral —
  it is an unanswered checklist, which is never a pass.
- **A rejected run with the bound unspent stays open**, not finalised — continue it with
  `pixelproof retake --run <id>` (step 6 above) rather than starting a new run.

Dropping `--judge` remains the right choice for a quick single asset that needs no recorded
semantic evidence: `generate` then makes exactly one provider call, `--retakes` is refused,
and `spec.retakes` is not read. Use `--judge host` whenever this host must be the one to read
and record the verdicts. Use `--judge codex` when the Codex CLI reading and judging the image
itself is acceptable — it is a paid call this host does not have to wait on or answer for, and
it spends up to `--retakes` generations plus that many judge calls on its own.

## Receipt

Finish with a compact receipt containing:

- attempts made;
- the correction applied for each retake (printed by the tool, or read from the run's report);
- the mechanical verdict, including skipped checks;
- every semantic criterion and its final verdict;
- the run id and its final state when `--judge host` or `--judge codex` was used;
- the selected file and overall verdict (`PASS`, `FAIL`, or `PARTIALLY VERIFIED`).
