/**
 * Bounded raw-pixel sampling for the heuristic prefilters.
 *
 * Every analysis in this directory needs real pixels, and a 3840-edge image has
 * up to ~14.7M of them. So nothing here reads a full-resolution buffer: the
 * decoder downsamples to a fixed square first, and all per-pixel JavaScript then
 * runs on a constant-size sample regardless of the input. The cost of a
 * prefilter has to be dominated by the decode, or it is not a prefilter.
 *
 * `sharp` arrives injected, exactly as `runMechanicalChecks` receives it from
 * `inspectImage` — this module never imports it. When it is absent these
 * analyses cannot run at all, and callers must report SKIP rather than quietly
 * substituting a weaker answer.
 */

/** The reason string every prefilter uses when the decoder is missing. */
export const SKIP_REASON_NO_DECODER = 'sharp unavailable';

/**
 * Sample edges, chosen per analysis rather than shared:
 *
 * - pHash is defined on a 32x32 luma grid (see phash.mjs).
 * - Palette extraction wants enough pixels for stable cluster means but not
 *   more; 64x64 = 4096 samples.
 * - Near-uniform detection is the one prefilter that can *reject*, so it runs at
 *   the largest sample, to reduce the chance that a small real feature is
 *   smeared into the background before it is measured.
 */
export const PHASH_SAMPLE_EDGE = 32;
export const PALETTE_SAMPLE_EDGE = 64;
export const UNIFORMITY_SAMPLE_EDGE = 256;

/**
 * The resampling kernel is pinned rather than left to the default so that a hash
 * or a palette is reproducible for a given libvips build. It is *not* guaranteed
 * stable across libvips versions; a stored pHash corpus is therefore tied to the
 * decoder that produced it.
 */
export const SAMPLE_KERNEL = 'lanczos3';

export const DEFAULT_BACKGROUND = Object.freeze({ r: 255, g: 255, b: 255 });

/**
 * Decode `filePath` down to an `edge` x `edge` RGBA sample.
 *
 * Aspect ratio is deliberately not preserved (`fit: 'fill'`). These analyses ask
 * what colours and what coarse structure are present, not where; distorting the
 * geometry keeps the sample count exactly constant and matches how a DCT
 * perceptual hash is conventionally defined.
 */
export async function loadBoundedSample(sharp, filePath, edge) {
  if (!sharp) throw new Error('loadBoundedSample requires a decoder; callers must SKIP without one');
  if (!Number.isInteger(edge) || edge <= 0) throw new Error('edge must be a positive integer');

  const { data, info } = await sharp(filePath, { failOn: 'error' })
    .resize({ width: edge, height: edge, fit: 'fill', kernel: SAMPLE_KERNEL })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return { data, info };
}

/**
 * Flatten an RGBA sample to opaque RGB triplets.
 *
 * Two different things happen to alpha, and the difference is deliberate.
 * Partially transparent pixels are composited over `background`, because that is
 * the only way to give them a colour at all. Fully transparent pixels are
 * *dropped*: they carry no colour information, and folding them in as background
 * would make a transparent logo's dominant palette report the background it does
 * not contain. `alphaFloor` is the alpha at or below which a pixel counts as
 * carrying nothing.
 *
 * ADR 0013 leaves the compositing background undecided, so it is a parameter and
 * the default (white) is recorded rather than hidden.
 */
export function flattenSample({ data, info }, { background = DEFAULT_BACKGROUND, alphaFloor = 0 } = {}) {
  const channels = info.channels;
  const pixelCount = info.width * info.height;
  const rgb = new Uint8Array(pixelCount * 3);
  let kept = 0;
  let dropped = 0;

  for (let i = 0; i < pixelCount; i += 1) {
    const offset = i * channels;
    const alpha = channels >= 4 ? data[offset + 3] : 255;
    if (alpha <= alphaFloor) {
      dropped += 1;
      continue;
    }
    const target = kept * 3;
    if (alpha === 255) {
      rgb[target] = data[offset];
      rgb[target + 1] = data[offset + 1];
      rgb[target + 2] = data[offset + 2];
    } else {
      const a = alpha / 255;
      rgb[target] = Math.round(data[offset] * a + background.r * (1 - a));
      rgb[target + 1] = Math.round(data[offset + 1] * a + background.g * (1 - a));
      rgb[target + 2] = Math.round(data[offset + 2] * a + background.b * (1 - a));
    }
    kept += 1;
  }

  return { rgb: rgb.subarray(0, kept * 3), count: kept, dropped };
}

/**
 * BT.601 luma over the gamma-encoded values, composited over `background`.
 *
 * Gamma-encoded rather than linear on purpose: this feeds the perceptual hash,
 * and the conventional DCT-hash definition operates on the encoded grey channel.
 * Switching to linear luma would produce different hashes, so any stored corpus
 * would be invalidated.
 */
export function lumaSample({ data, info }, { background = DEFAULT_BACKGROUND } = {}) {
  const channels = info.channels;
  const pixelCount = info.width * info.height;
  const luma = new Float64Array(pixelCount);

  for (let i = 0; i < pixelCount; i += 1) {
    const offset = i * channels;
    const alpha = channels >= 4 ? data[offset + 3] : 255;
    let r = data[offset];
    let g = data[offset + 1];
    let b = data[offset + 2];
    if (alpha !== 255) {
      const a = alpha / 255;
      r = r * a + background.r * (1 - a);
      g = g * a + background.g * (1 - a);
      b = b * a + background.b * (1 - a);
    }
    luma[i] = 0.299 * r + 0.587 * g + 0.114 * b;
  }

  return { luma, width: info.width, height: info.height };
}
