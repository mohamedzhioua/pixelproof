/**
 * Legacy import path for the Codex provider (ADR 0003).
 *
 * The implementation moved to `providers/codex.mjs`, where it implements the
 * provider contract. This file stays because `scripts/generate.mjs` and the v1
 * characterization tests import it, and neither the path nor the exported shape
 * is ours to change while the compatibility façade stands. It re-exports; it
 * does not reimplement.
 *
 * The geometry constants are re-exported too. They were module-private in v1,
 * so nothing depends on them yet — but they are now derived from one capability
 * record rather than duplicated, and naming them here keeps a caller from
 * hardcoding 3840 a third time.
 */

export {
  CODEX_DIMENSION_MULTIPLE,
  CODEX_MAX_ASPECT_RATIO,
  CODEX_MAX_EDGE,
  CODEX_MAX_PIXELS,
  CODEX_MIN_PIXELS,
  assertCodexSize,
  generateWithCodex,
} from '../../providers/codex.mjs';
