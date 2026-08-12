---
name: vector
description: >-
  Author or render SVG vector assets such as diagrams, icons, logos, charts, badges, maps,
  and interface illustrations; use when the requested image needs editable geometry, crisp
  scaling, deterministic layout, or correctly rendered text.
---

# Pixelproof vector workflow

For diagrams, icons, logos, and charts, write the SVG markup directly. Vector is preferable
to generative raster output here because it is editable, deterministic, quota-free, crisp at
every size, and renders deliberate text correctly.

Use `${CLAUDE_PLUGIN_ROOT}` as the repository root for a plugin installation. For a skill
copied into `~/.claude/skills/`, use the user's Pixelproof clone path or `PIXELPROOF_ROOT`.

## Author and validate

1. Resolve the intended canvas, viewBox, palette, typography, labels, accessibility needs,
   and output format. Use a spec when repeatable constraints matter.
2. Author complete SVG XML with a root `<svg>` element and an explicit `viewBox`. Keep shapes,
   grouping, and names understandable so the asset remains editable. Do not wrap the markup
   in Markdown fences when saving it.
3. Save the markup to a source file, then route it through the provider so malformed XML,
   a wrong root, duplicate attributes, or a missing viewBox is rejected:

   ```sh
   node "${CLAUDE_PLUGIN_ROOT:-$PIXELPROOF_ROOT}/scripts/generate.mjs" --provider svg --svg-file "<source.svg>" --out "<target.svg>"
   ```

   The provider also accepts SVG on stdin. For a PNG target, pass `--out <target.png>` and
   `--size WxH`; Pixelproof writes the reusable SVG beside it and rasterises with `sharp`.
   If `sharp` is absent, it keeps the SVG and warns clearly instead of throwing away the work.
4. Read the SVG and, when rasterised, read the PNG with the Read tool. Check composition,
   clipping, legibility, labels, and every semantic constraint.
5. The mechanical tier applies to the rasterised PNG exactly as it does to generated raster
   art:

   ```sh
   node "${CLAUDE_PLUGIN_ROOT:-$PIXELPROOF_ROOT}/scripts/verify.mjs" --file "<target.png>" --spec "<spec.json>"
   ```

Do not use raster generation merely to imitate a diagram or logo that can be represented
cleanly as editable geometry.
