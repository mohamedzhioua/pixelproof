/**
 * Dimension resolution: what pixel size a run should ask a provider for.
 *
 * Two sources can express an opinion — an explicitly requested size and the
 * spec's mechanical block — and they can disagree. The spec wins, because the
 * spec is also what the result is verified against; honouring the request would
 * generate an image that is guaranteed to fail its own verification. The
 * disagreement is still reported rather than swallowed, so a user who typed a
 * size never silently gets a different one.
 *
 * These messages are frozen public surface (ADR 0003).
 */

export const DEFAULT_WIDTH = 1024;
export const DEFAULT_HEIGHT = 1024;

/** Aspect agreement tolerance, matching the verifier's own tolerance. */
export const ASPECT_TOLERANCE = 0.01;

export function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return number;
}

/** Parse a `WxH` request. `null` means "no size was requested". */
export function parseSize(value) {
  if (!value) return null;
  const match = value.match(/^(\d+)[xX](\d+)$/);
  if (!match) throw new Error('--size must use the form WxH, for example 1254x1254');
  return {
    width: positiveInteger(match[1], 'size width'),
    height: positiveInteger(match[2], 'size height'),
  };
}

/** Parse a spec `width:height` aspect into a ratio. `null` means undeclared. */
export function parseAspect(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string') throw new Error('mechanical.aspect must be a string');
  const match = value.match(/^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*$/);
  if (!match) throw new Error('mechanical.aspect must use the form width:height');
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width <= 0 || height <= 0) throw new Error('mechanical.aspect values must be positive');
  return width / height;
}

/**
 * Precedence: declared spec dimensions, then the requested size, then the
 * defaults. An aspect only *derives* a missing edge when no size was requested —
 * an explicit request is a complete answer and deriving over it would silently
 * rewrite it — but a declared aspect always has to agree with the result, so a
 * spec that contradicts itself is rejected instead of being generated.
 */
export function resolveDimensions(explicit, mechanical) {
  const declaredWidth = mechanical.width === undefined
    ? null
    : positiveInteger(mechanical.width, 'mechanical.width');
  const declaredHeight = mechanical.height === undefined
    ? null
    : positiveInteger(mechanical.height, 'mechanical.height');
  const aspect = parseAspect(mechanical.aspect);

  let width = declaredWidth ?? explicit?.width ?? DEFAULT_WIDTH;
  let height = declaredHeight ?? explicit?.height ?? DEFAULT_HEIGHT;

  if (!explicit && aspect) {
    if (declaredWidth && !declaredHeight) {
      height = Math.max(1, Math.round(width / aspect));
    } else if (declaredHeight && !declaredWidth) {
      width = Math.max(1, Math.round(height * aspect));
    } else if (!declaredWidth && !declaredHeight) {
      height = Math.max(1, Math.round(width / aspect));
    }
  }

  if (aspect && Math.abs(width / height - aspect) > ASPECT_TOLERANCE) {
    throw new Error(
      `Resolved dimensions ${width}x${height} conflict with spec aspect ${mechanical.aspect}`,
    );
  }
  return { width, height };
}

/**
 * The disagreement notice for a requested size the spec overruled. Returns the
 * sentence to report, or `null` when there is nothing to report. Core owns the
 * wording (it is frozen surface); the caller owns the channel it goes to.
 */
export function describeSizeDisagreement(requestedSize, resolved) {
  if (!requestedSize) return null;
  if (requestedSize.width === resolved.width && requestedSize.height === resolved.height) {
    return null;
  }
  return `--size requested ${requestedSize.width}x${requestedSize.height}, but the spec `
    + `dimensions are ${resolved.width}x${resolved.height}; the spec is authoritative.`;
}
