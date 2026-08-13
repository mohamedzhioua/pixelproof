/**
 * Blank / near-uniform frame detection.
 *
 * This is the one prefilter that can honestly *reject*, because its threshold is
 * not a taste call. A frame is near-uniform when no sampled pixel differs from
 * the frame's mean colour by more than a just-noticeable difference — that is,
 * when there is by definition nothing to see. The number comes from CIEDE2000's
 * own scaling (a unit is the perceptibility threshold), not from a corpus.
 *
 * The honest limitation: uniformity is measured on a 256-edge sample, so a
 * feature smaller than roughly one part in 256 of the frame is resampled toward
 * the background before it is measured. In practice a small dark mark still lifts
 * its sample cell well past a JND, but the bound is stated rather than implied,
 * and this is why the near-uniform sample is the largest of the three.
 */

import { JUST_NOTICEABLE_DELTA_E, deltaE2000, srgbToLab } from './color.mjs';

/** A frame with no pixel more than this far from its mean colour shows nothing. */
export const NEAR_UNIFORM_MAX_DELTA_E = JUST_NOTICEABLE_DELTA_E;

/**
 * Measure how much visible variation a flattened sample contains.
 *
 * Returns the mean colour, the largest and mean CIEDE2000 deviation from it, and
 * the share of the sample within a JND of it. `nearUniform` applies the rule
 * above; everything else is reported so a caller can be stricter without this
 * module guessing at what stricter means.
 */
export function measureUniformity(rgb, { maxDeltaE = NEAR_UNIFORM_MAX_DELTA_E } = {}) {
  const pixelCount = Math.floor(rgb.length / 3);
  if (pixelCount === 0) {
    return {
      pixels: 0,
      meanHex: null,
      maxDeltaE: null,
      meanDeltaE: null,
      uniformShare: null,
      nearUniform: false,
    };
  }

  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  for (let i = 0; i < pixelCount; i += 1) {
    const offset = i * 3;
    sumR += rgb[offset];
    sumG += rgb[offset + 1];
    sumB += rgb[offset + 2];
  }
  const mean = {
    r: Math.round(sumR / pixelCount),
    g: Math.round(sumG / pixelCount),
    b: Math.round(sumB / pixelCount),
  };
  const meanLab = srgbToLab(mean.r, mean.g, mean.b);

  // One Lab conversion per distinct colour: a near-uniform frame has very few,
  // which is exactly the case this prefilter runs on most often.
  const cache = new Map();
  let largest = 0;
  let total = 0;
  let within = 0;
  for (let i = 0; i < pixelCount; i += 1) {
    const offset = i * 3;
    const key = (rgb[offset] << 16) | (rgb[offset + 1] << 8) | rgb[offset + 2];
    let difference = cache.get(key);
    if (difference === undefined) {
      difference = deltaE2000(meanLab, srgbToLab(rgb[offset], rgb[offset + 1], rgb[offset + 2]));
      cache.set(key, difference);
    }
    total += difference;
    if (difference > largest) largest = difference;
    if (difference <= JUST_NOTICEABLE_DELTA_E) within += 1;
  }

  return {
    pixels: pixelCount,
    meanHex: `#${[mean.r, mean.g, mean.b].map((c) => c.toString(16).padStart(2, '0')).join('')}`,
    maxDeltaE: largest,
    meanDeltaE: total / pixelCount,
    uniformShare: within / pixelCount,
    nearUniform: largest <= maxDeltaE,
    distinctColors: cache.size,
  };
}
