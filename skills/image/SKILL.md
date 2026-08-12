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
6. Use Claude Code's **Read tool to read the produced image file itself**. Judge the visible
   result against every string in `spec.semantic`, one by one. State each criterion verbatim,
   mark it `PASS` or `FAIL`, and give a short piece of visible evidence. Never infer semantic
   success from the prompt, filename, Codex output, or mechanical report.
7. If any mechanical or semantic criterion fails, construct the next prompt from the prior
   prompt plus a direct correction naming each observed violation. Examples: "remove the
   invented label on the front face", "the lower-right lockup area must remain empty white",
   or "extend the seamless background into all four corners." Generate a new attempt file,
   rerun the mechanical tier, and read the new image again.
8. Stop immediately when both tiers pass, or when the maximum attempt count is reached.
   Never loop forever and never silently accept a failure. Copy the passing attempt to the
   requested destination. On exhaustion, copy only the best attempt if the user asked for an
   output, label it as not fully passing, and list every remaining failure.

## Receipt

Finish with a compact receipt containing:

- attempts made;
- the prompt correction made for each retake;
- the mechanical verdict, including skipped checks;
- every semantic criterion and its final verdict;
- the selected file and overall verdict (`PASS`, `FAIL`, or `PARTIALLY VERIFIED`).
