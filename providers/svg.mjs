/**
 * SVG: a trusted built-in provider adapter (ADR 0004, ADR 0005).
 *
 * The provider's source is markup, not a text prompt, so a generate request
 * carries it in `options.svgText`. `prompt` is accepted as a fallback because
 * the contract requires a non-empty prompt and a caller that has only the
 * markup should not have to duplicate it.
 *
 * Note the import direction. The XML validator and writer still live in
 * `scripts/providers/svg.mjs` rather than here, and that is deliberate:
 * `test/svg-provider.test.mjs` copies that exact file to a temporary directory
 * and imports the copy, which is how it proves the degraded no-`sharp` path
 * honestly (from outside the repo, `sharp` genuinely does not resolve). A copy
 * of a re-export shim would resolve nothing at all. The file must therefore stay
 * self-contained until that characterization test is renegotiated, so this
 * adapter wraps it instead of the other way round. When the v1 façade is
 * retired, the body moves here and the direction inverts in one step.
 */

import path from 'node:path';

import { generateWithSvg, validateSvgXml } from '../scripts/providers/svg.mjs';
import { AdapterError } from '../core/contracts/errors.mjs';
import {
  PROTOCOL_VERSION,
  preflight,
  validateGenerateRequest,
  validateManifest,
} from '../core/contracts/provider.mjs';

export { generateWithSvg, validateSvgXml };

export const id = 'svg';

export const manifest = validateManifest({
  protocol: PROTOCOL_VERSION,
  id,
  // Vector always; raster only when `sharp` is installed. The manifest declares
  // the provider's ambition and the run reports the degradation, because a
  // capability record that changed shape with an optional dependency would make
  // preflight results irreproducible across machines.
  kinds: ['vector', 'raster'],
  capabilities: {
    // Markup has no intrinsic pixel bounds; rasterisation scales to whatever is
    // asked for, so declaring limits here would invent constraints that do not
    // exist.
    transparency: true,
    seed: false,
    references: false,
    negativePrompt: false,
  },
});

/** Always available: it is markup and the standard library. */
export function detect() {
  return { available: true, reason: null };
}

function sourceMarkup(request) {
  const fromOptions = request.options?.svgText;
  if (typeof fromOptions === 'string' && fromOptions.trim() !== '') return fromOptions;
  return request.prompt;
}

/**
 * Contract entry point (ADR 0005). Rasterisation may be unavailable, which is
 * reported as a warning on a successful response rather than as a failure — the
 * validated vector was still produced, and v1's callers depend on that
 * distinction.
 */
export async function generate(rawRequest) {
  const request = validateGenerateRequest(rawRequest);
  preflight(manifest, request);

  const extension = path.extname(request.out).toLowerCase();
  if ((request.kind === 'vector' && extension !== '.svg')
    || (request.kind === 'raster' && extension !== '.png')) {
    throw new AdapterError(
      'INVALID_REQUEST',
      `Provider "${id}" cannot write kind "${request.kind}" to "${extension || 'no extension'}"`,
      { retryable: false, details: { kind: request.kind, out: request.out } },
    );
  }

  const startedAt = Date.now();
  try {
    const result = await generateWithSvg({
      svgText: sourceMarkup(request),
      outPath: request.out,
      width: request.width,
      height: request.height,
    });

    if (result.outputPath !== path.resolve(request.out)) {
      // v1's CLI reports this as success with a warning. The contract cannot:
      // an adapter that wrote a different path than it was asked for has not
      // satisfied the request, and `parseGenerateResponse` would reject the
      // claim anyway. The validated vector is left on disk and named in the
      // details rather than silently discarded.
      throw new AdapterError(
        'PROVIDER_UNAVAILABLE',
        result.warnings[0] ?? `Provider "${id}" could not write ${request.out}`,
        { retryable: false, details: { wrote: result.outputPath, requested: request.out } },
      );
    }

    return {
      protocol: PROTOCOL_VERSION,
      ok: true,
      file: result.outputPath,
      provider: id,
      model: null,
      durationMs: Date.now() - startedAt,
      warnings: [...result.warnings],
      meta: { viewBox: result.viewBox, svgPath: result.svgPath, pngPath: result.pngPath },
    };
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    // Malformed markup is the caller's input, not an internal fault.
    throw new AdapterError('INVALID_REQUEST', error?.message ?? String(error), {
      retryable: false,
      details: { provider: id },
      cause: error,
    });
  }
}
