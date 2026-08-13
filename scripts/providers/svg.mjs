/**
 * Legacy import path for the SVG provider (ADR 0003).
 *
 * The implementation moved to `providers/svg.mjs`, where it implements the
 * provider contract. This file stays because the v1 characterization tests
 * import it, and neither the path nor the exported shape is ours to change
 * while the compatibility façade stands. It re-exports; it does not
 * reimplement.
 *
 * Until now the direction was the other way round — `providers/svg.mjs` wrapped
 * this file — which made the new layer depend on the façade that is due for
 * deletion. The blocker was `test/svg-provider.test.mjs`, which copies the
 * provider to a directory with no `node_modules` to prove the degraded
 * no-`sharp` path; a copy of a re-export shim resolves nothing. The harness's
 * `isolateModule` now copies the imported layers alongside the module, so the
 * copied file no longer has to be self-contained and the direction matches
 * `providers/codex.mjs`.
 */

export { generateWithSvg, validateSvgXml } from '../../providers/svg.mjs';
