/**
 * Dominant palette extraction, and distance from a brand palette.
 *
 * Two different questions live here and they are answered by different code on
 * purpose:
 *
 * - *What colours dominate this image?* — median-cut clustering over a bounded
 *   sample. Descriptive. Good for a report, and for a human or a model to read.
 * - *Is this brand colour present at all?* — measured against every sampled
 *   pixel, not against the dominant clusters. A brand accent covering 2% of a
 *   frame will never be one of five dominant clusters, so answering the presence
 *   question from the palette would produce a confident false negative on
 *   exactly the assets a brand check exists for.
 *
 * On tolerance. A CIEDE2000 tolerance cannot be defaulted to one number, and the
 * measurement is in docs/evidence/heuristic-calibration.md: the +/-3-per-channel
 * tolerance that mechanical.mjs already justifies from three measured runs maps
 * to a CIEDE2000 difference anywhere from ~0 to 7.01 depending on where in the
 * gamut the colour sits (worst case near dark saturated colours). So instead of
 * inventing a flat dE00 number, the acceptance radius is *derived per colour*
 * from that existing per-channel tolerance.
 */

import { DEFAULT_CORNER_TOLERANCE } from '../verification/mechanical.mjs';
import { deltaE2000, srgbToLab } from './color.mjs';

export const DEFAULT_PALETTE_SIZE = 5;

/**
 * Reused rather than reinvented: mechanical.mjs derives +/-3 per channel from
 * three measured generation runs of a requested pure white. Using the same
 * number keeps one tolerance story in the project instead of two.
 */
export const DEFAULT_CHANNEL_TOLERANCE = DEFAULT_CORNER_TOLERANCE;

function clampChannel(value) {
  return value < 0 ? 0 : value > 255 ? 255 : value;
}

/**
 * The CIEDE2000 radius that a per-channel tolerance corresponds to *at this
 * colour*. Evaluates the corners of the +/-tolerance cube, which is where the
 * maximum sits, and returns the largest difference found.
 */
export function deltaERadiusForChannelTolerance(rgb, channelTolerance = DEFAULT_CHANNEL_TOLERANCE) {
  if (!Number.isInteger(channelTolerance) || channelTolerance < 0 || channelTolerance > 255) {
    throw new Error('channelTolerance must be an integer from 0 to 255');
  }
  const base = srgbToLab(rgb.r, rgb.g, rgb.b);
  const offsets = [-channelTolerance, 0, channelTolerance];
  let radius = 0;
  for (const dr of offsets) {
    for (const dg of offsets) {
      for (const db of offsets) {
        const candidate = srgbToLab(
          clampChannel(rgb.r + dr),
          clampChannel(rgb.g + dg),
          clampChannel(rgb.b + db),
        );
        const difference = deltaE2000(base, candidate);
        if (difference > radius) radius = difference;
      }
    }
  }
  return radius;
}

function boxBounds(rgb, indices, start, end) {
  const min = [255, 255, 255];
  const max = [0, 0, 0];
  for (let i = start; i < end; i += 1) {
    const offset = indices[i] * 3;
    for (let c = 0; c < 3; c += 1) {
      const value = rgb[offset + c];
      if (value < min[c]) min[c] = value;
      if (value > max[c]) max[c] = value;
    }
  }
  return { min, max, spread: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}

/**
 * Median cut over the sampled pixels.
 *
 * Chosen over k-means because it is deterministic without needing a seeded RNG:
 * the same pixels always yield the same palette, which matters when a palette
 * ends up in a report someone diffs. Splitting order is "widest channel spread
 * first, ties broken by box position", so no step depends on iteration accident.
 */
export function dominantPalette(rgb, count = DEFAULT_PALETTE_SIZE, { channelTolerance } = {}) {
  if (!Number.isInteger(count) || count <= 0) throw new Error('palette count must be a positive integer');
  const pixelCount = Math.floor(rgb.length / 3);
  if (pixelCount === 0) return [];

  const indices = new Int32Array(pixelCount);
  for (let i = 0; i < pixelCount; i += 1) indices[i] = i;

  let boxes = [{ start: 0, end: pixelCount, ...boxBounds(rgb, indices, 0, pixelCount) }];

  while (boxes.length < count) {
    let target = -1;
    let widest = 0;
    for (let i = 0; i < boxes.length; i += 1) {
      const box = boxes[i];
      if (box.end - box.start < 2) continue;
      const spread = Math.max(box.spread[0], box.spread[1], box.spread[2]);
      if (spread > widest) {
        widest = spread;
        target = i;
      }
    }
    if (target === -1 || widest === 0) break;

    const box = boxes[target];
    const channel = box.spread.indexOf(Math.max(box.spread[0], box.spread[1], box.spread[2]));
    const slice = Array.from(indices.subarray(box.start, box.end));
    slice.sort((left, right) => rgb[left * 3 + channel] - rgb[right * 3 + channel] || left - right);
    indices.set(slice, box.start);

    const middle = box.start + Math.floor((box.end - box.start) / 2);
    boxes = [
      ...boxes.slice(0, target),
      { start: box.start, end: middle, ...boxBounds(rgb, indices, box.start, middle) },
      { start: middle, end: box.end, ...boxBounds(rgb, indices, middle, box.end) },
      ...boxes.slice(target + 1),
    ];
  }

  const entries = boxes.map((box) => {
    let r = 0;
    let g = 0;
    let b = 0;
    for (let i = box.start; i < box.end; i += 1) {
      const offset = indices[i] * 3;
      r += rgb[offset];
      g += rgb[offset + 1];
      b += rgb[offset + 2];
    }
    const size = box.end - box.start;
    const mean = {
      r: Math.round(r / size),
      g: Math.round(g / size),
      b: Math.round(b / size),
    };
    return {
      hex: rgbToHexLower(mean),
      rgb: mean,
      share: size / pixelCount,
      pixels: size,
      toleranceRadius: deltaERadiusForChannelTolerance(mean, channelTolerance),
    };
  });

  return entries.sort((left, right) => right.share - left.share || left.hex.localeCompare(right.hex));
}

function rgbToHexLower({ r, g, b }) {
  return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * For each brand colour, the closest sampled pixel and the share of the sample
 * that lies within the derived tolerance radius.
 *
 * `present` is a measurement, not a verdict: it says a pixel indistinguishable
 * from the brand colour (to within the project's own generation tolerance)
 * exists. It says nothing about whether it is in the right place, at the right
 * size, or on the right element.
 */
export function brandColorCoverage(rgb, brandColors, { channelTolerance } = {}) {
  const pixelCount = Math.floor(rgb.length / 3);
  const labCache = new Map();

  function labFor(offset) {
    const key = (rgb[offset] << 16) | (rgb[offset + 1] << 8) | rgb[offset + 2];
    let lab = labCache.get(key);
    if (lab === undefined) {
      lab = srgbToLab(rgb[offset], rgb[offset + 1], rgb[offset + 2]);
      labCache.set(key, lab);
    }
    return lab;
  }

  return brandColors.map((color) => {
    const radius = deltaERadiusForChannelTolerance(color, channelTolerance);
    const target = srgbToLab(color.r, color.g, color.b);
    let nearest = Number.POSITIVE_INFINITY;
    let within = 0;
    for (let i = 0; i < pixelCount; i += 1) {
      const difference = deltaE2000(target, labFor(i * 3));
      if (difference < nearest) nearest = difference;
      if (difference <= radius) within += 1;
    }
    return {
      hex: rgbToHexLower(color),
      nearestDeltaE: pixelCount === 0 ? null : nearest,
      toleranceRadius: radius,
      share: pixelCount === 0 ? 0 : within / pixelCount,
      present: pixelCount > 0 && nearest <= radius,
    };
  });
}

/**
 * Distance from an extracted palette to a brand palette: for each brand colour,
 * the nearest *dominant* entry. Descriptive only — see the module note on why
 * presence is not answered from here.
 */
export function brandPaletteDistance(palette, brandColors) {
  return brandColors.map((color) => {
    const target = srgbToLab(color.r, color.g, color.b);
    let best = null;
    for (const entry of palette) {
      const difference = deltaE2000(target, srgbToLab(entry.rgb.r, entry.rgb.g, entry.rgb.b));
      if (best === null || difference < best.deltaE) best = { hex: entry.hex, share: entry.share, deltaE: difference };
    }
    return { hex: rgbToHexLower(color), nearest: best };
  });
}
