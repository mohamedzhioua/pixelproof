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
2. Set the maximum number of total attempts from `spec.retakes`; use 3 when it is absent.
   This is a hard bound, not a suggestion.
3. Keep attempt files in `.pixelproof-scratch/` with distinct names such as
   `<asset>-attempt-1.png`. This preserves earlier candidates so the best attempt can still
   be selected if the final retake regresses.
4. Generate one candidate:

   ```sh
   node "${CLAUDE_PLUGIN_ROOT:-$PIXELPROOF_ROOT}/scripts/generate.mjs" --prompt "<specific prompt>" --out ".pixelproof-scratch/<asset>-attempt-1.png" --spec "<spec path>"
   ```

   A non-zero exit may mean the image was created but failed its automatic mechanical gate.
   Inspect the report and the file; do not discard the evidence.
5. Run the mechanical tier explicitly and read every row:

   ```sh
   node "${CLAUDE_PLUGIN_ROOT:-$PIXELPROOF_ROOT}/scripts/verify.mjs" --file ".pixelproof-scratch/<asset>-attempt-1.png" --spec "<spec path>"
   ```

   `FAIL` is a failed tier. `SKIP` means an optional decoder was unavailable; report that
   criterion as unverified rather than quietly calling it a pass. Do not waste retakes on a
   missing decoder because another image cannot repair the environment.
6. Judge every entry in `spec.semantic` against the image itself. **Open the produced file
   with whatever image-reading capability this host has** — do not infer semantic success
   from the prompt, the filename, Codex output, or the mechanical report. State each
   criterion verbatim, mark it `pass`, `fail` or `unsure`, and give a short piece of visible
   evidence. `unsure` is a real answer and is never a pass.

   Recording the verdicts through the tool, rather than only in your reply, is the supported
   path — it is what puts them in the run's evidence. See **Recording the semantic tier**
   below.
7. If any mechanical or semantic criterion fails, construct the next prompt from the prior
   prompt plus a direct correction naming each observed violation. Examples: "remove the
   invented label on the front face", "the lower-right lockup area must remain empty white",
   or "extend the seamless background into all four corners." Generate a new attempt file,
   rerun the mechanical tier, and read the new image again.
8. Stop immediately when both tiers pass, or when the maximum attempt count is reached.
   Never loop forever and never silently accept a failure. Copy the passing attempt to the
   requested destination. On exhaustion, copy only the best attempt if the user asked for an
   output, label it as not fully passing, and list every remaining failure.

## Recording the semantic tier

`--judge host` turns step 6 into two invocations that never block on each other. This exists
because the blocking shape is impossible: the agent that ran `generate` is the only entity
that can open the image, and while it waits on the child process it cannot read anything.

```sh
pixelproof generate --prompt "<prompt>" --out output/hero.png --spec specs/hero.json --judge host
# exit 2 — a checklist was written and no verdict exists yet
```

Then:

1. Read `judge-request-1.json` in the run directory the command names, or run
   `pixelproof judge show --run <id>` to print the same checklist again.
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

Steps 4–6 without `--judge` remain exactly as they were, and are the right choice for a
quick single asset. Use `--judge host` when the verdicts need to be evidence.

## Receipt

Finish with a compact receipt containing:

- attempts made;
- the prompt correction made for each retake;
- the mechanical verdict, including skipped checks;
- every semantic criterion and its final verdict;
- the run id and its final state when `--judge host` was used;
- the selected file and overall verdict (`PASS`, `FAIL`, or `PARTIALLY VERIFIED`).
