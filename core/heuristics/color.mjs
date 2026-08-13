/**
 * Colour science: sRGB/D65 -> CIELAB, and CIEDE2000.
 *
 * Only one colour contract is implemented here, deliberately: sRGB primaries
 * with the D65 white point, and CIEDE2000 with kL = kC = kH = 1. ADR 0013 leaves
 * anything beyond that (ICC-aware conversion, other observers, other parametric
 * weightings) undecided, so this module refuses to guess at them rather than
 * inventing a second contract nobody asked for.
 *
 * CIEDE2000 is transcribed from the published formulation (Sharma, Wu and Dalal,
 * "The CIEDE2000 color-difference formula: implementation notes, supplementary
 * test data, and mathematical observations", Color Res. Appl. 30(1), 2005,
 * doi:10.1002/col.20070) including its two sharp edges: the mean-hue branch when
 * either chroma is zero, and the hue difference wrapping at +/-180 degrees. Both
 * are the places naive implementations go wrong, and both are what the published
 * supplementary dataset is designed to catch — see
 * test/heuristics-color.test.mjs, which checks all 34 reference pairs.
 */

/** D65 tristimulus values for the 2-degree standard observer, Y normalised to 1. */
export const D65_WHITE = Object.freeze({ x: 0.95047, y: 1, z: 1.08883 });

/**
 * A CIEDE2000 difference of about 1 is the conventional just-noticeable
 * difference: the formula is scaled so that a unit corresponds to the threshold
 * of perceptibility. It is the only threshold in this module that comes from the
 * literature rather than from a corpus, which is why it is the only one exported.
 */
export const JUST_NOTICEABLE_DELTA_E = 1;

const DELTA = 6 / 29;
const DELTA_CUBED = DELTA * DELTA * DELTA;
const POW_25_7 = 25 ** 7;
const DEGREES = 180 / Math.PI;
const RADIANS = Math.PI / 180;

/** Undo the sRGB transfer function for one 0-255 channel. */
export function srgbChannelToLinear(value) {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function srgbToXyz(r, g, b) {
  const rl = srgbChannelToLinear(r);
  const gl = srgbChannelToLinear(g);
  const bl = srgbChannelToLinear(b);
  return {
    x: 0.4124564 * rl + 0.3575761 * gl + 0.1804375 * bl,
    y: 0.2126729 * rl + 0.7151522 * gl + 0.0721750 * bl,
    z: 0.0193339 * rl + 0.1191920 * gl + 0.9503041 * bl,
  };
}

function labTransfer(t) {
  return t > DELTA_CUBED ? Math.cbrt(t) : t / (3 * DELTA * DELTA) + 4 / 29;
}

/** Convert one 8-bit sRGB triplet to CIELAB under D65. */
export function srgbToLab(r, g, b) {
  const { x, y, z } = srgbToXyz(r, g, b);
  const fx = labTransfer(x / D65_WHITE.x);
  const fy = labTransfer(y / D65_WHITE.y);
  const fz = labTransfer(z / D65_WHITE.z);
  return {
    L: 116 * fy - 16,
    a: 500 * (fx - fy),
    b: 200 * (fy - fz),
  };
}

function hueDegrees(a, b) {
  if (a === 0 && b === 0) return 0;
  const degrees = Math.atan2(b, a) * DEGREES;
  return degrees < 0 ? degrees + 360 : degrees;
}

/**
 * CIEDE2000 colour difference between two CIELAB values.
 *
 * `kL`, `kC` and `kH` default to 1 (the reference conditions). They are exposed
 * because the formula defines them, not because anything here varies them.
 */
export function deltaE2000(lab1, lab2, { kL = 1, kC = 1, kH = 1 } = {}) {
  const { L: L1, a: a1, b: b1 } = lab1;
  const { L: L2, a: a2, b: b2 } = lab2;

  const c1 = Math.hypot(a1, b1);
  const c2 = Math.hypot(a2, b2);
  const cMean = (c1 + c2) / 2;
  const cMean7 = cMean ** 7;
  const g = 0.5 * (1 - Math.sqrt(cMean7 / (cMean7 + POW_25_7)));

  const a1p = (1 + g) * a1;
  const a2p = (1 + g) * a2;
  const c1p = Math.hypot(a1p, b1);
  const c2p = Math.hypot(a2p, b2);
  const h1p = hueDegrees(a1p, b1);
  const h2p = hueDegrees(a2p, b2);

  const deltaLp = L2 - L1;
  const deltaCp = c2p - c1p;

  // With either chroma at zero the hue is undefined, and the difference and the
  // mean both degenerate. Guarding this is what the reference pairs at a = b = 0
  // exist to verify.
  const chromaProduct = c1p * c2p;
  let deltahp = 0;
  if (chromaProduct !== 0) {
    deltahp = h2p - h1p;
    if (deltahp > 180) deltahp -= 360;
    else if (deltahp < -180) deltahp += 360;
  }
  const deltaHp = 2 * Math.sqrt(chromaProduct) * Math.sin((deltahp / 2) * RADIANS);

  const lpMean = (L1 + L2) / 2;
  const cpMean = (c1p + c2p) / 2;

  let hpMean;
  if (chromaProduct === 0) {
    hpMean = h1p + h2p;
  } else if (Math.abs(h1p - h2p) <= 180) {
    hpMean = (h1p + h2p) / 2;
  } else if (h1p + h2p < 360) {
    hpMean = (h1p + h2p + 360) / 2;
  } else {
    hpMean = (h1p + h2p - 360) / 2;
  }

  const t = 1
    - 0.17 * Math.cos((hpMean - 30) * RADIANS)
    + 0.24 * Math.cos(2 * hpMean * RADIANS)
    + 0.32 * Math.cos((3 * hpMean + 6) * RADIANS)
    - 0.20 * Math.cos((4 * hpMean - 63) * RADIANS);

  const sL = 1 + (0.015 * (lpMean - 50) ** 2) / Math.sqrt(20 + (lpMean - 50) ** 2);
  const sC = 1 + 0.045 * cpMean;
  const sH = 1 + 0.015 * cpMean * t;

  const deltaTheta = 30 * Math.exp(-(((hpMean - 275) / 25) ** 2));
  const cpMean7 = cpMean ** 7;
  const rC = 2 * Math.sqrt(cpMean7 / (cpMean7 + POW_25_7));
  const rT = -Math.sin(2 * deltaTheta * RADIANS) * rC;

  const termL = deltaLp / (kL * sL);
  const termC = deltaCp / (kC * sC);
  const termH = deltaHp / (kH * sH);

  return Math.sqrt(termL * termL + termC * termC + termH * termH + rT * termC * termH);
}

/** Convenience: CIEDE2000 between two 8-bit sRGB triplets. */
export function deltaE2000Srgb(rgb1, rgb2) {
  return deltaE2000(srgbToLab(rgb1.r, rgb1.g, rgb1.b), srgbToLab(rgb2.r, rgb2.g, rgb2.b));
}
