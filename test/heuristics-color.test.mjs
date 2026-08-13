import assert from 'node:assert/strict';
import test from 'node:test';

import {
  JUST_NOTICEABLE_DELTA_E,
  deltaE2000,
  deltaE2000Srgb,
  srgbToLab,
} from '../core/heuristics/color.mjs';
import { deltaERadiusForChannelTolerance } from '../core/heuristics/palette.mjs';

/**
 * The published CIEDE2000 supplementary test data (Sharma, Wu and Dalal, Color
 * Res. Appl. 30(1), 2005, doi:10.1002/col.20070). Thirty-four pairs, chosen by
 * the authors to exercise the branches an implementation gets wrong: the hue
 * wrap at +/-180 degrees (pairs 9-15), zero chroma (7-8), the R_T rotation term
 * in the blue region (29), and the very dark end where the L* term dominates
 * (33-34).
 *
 * This dataset is the reason an implementation can be *checked* rather than
 * believed. Two independent things have to agree for this test to pass: the
 * formula transcribed in color.mjs from the paper, and these tabulated values.
 * A wrong formula does not match correct data, and wrong data does not match a
 * correct formula, so 34 simultaneous four-decimal agreements is not something
 * either side can fake.
 */
const REFERENCE_PAIRS = Object.freeze([
  [[50.0000, 2.6772, -79.7751], [50.0000, 0.0000, -82.7485], 2.0425],
  [[50.0000, 3.1571, -77.2803], [50.0000, 0.0000, -82.7485], 2.8615],
  [[50.0000, 2.8361, -74.0200], [50.0000, 0.0000, -82.7485], 3.4412],
  [[50.0000, -1.3802, -84.2814], [50.0000, 0.0000, -82.7485], 1.0000],
  [[50.0000, -1.1848, -84.8006], [50.0000, 0.0000, -82.7485], 1.0000],
  [[50.0000, -0.9009, -85.5211], [50.0000, 0.0000, -82.7485], 1.0000],
  [[50.0000, 0.0000, 0.0000], [50.0000, -1.0000, 2.0000], 2.3669],
  [[50.0000, -1.0000, 2.0000], [50.0000, 0.0000, 0.0000], 2.3669],
  [[50.0000, 2.4900, -0.0010], [50.0000, -2.4900, 0.0009], 7.1792],
  [[50.0000, 2.4900, -0.0010], [50.0000, -2.4900, 0.0010], 7.1792],
  [[50.0000, 2.4900, -0.0010], [50.0000, -2.4900, 0.0011], 7.2195],
  [[50.0000, 2.4900, -0.0010], [50.0000, -2.4900, 0.0012], 7.2195],
  [[50.0000, -0.0010, 2.4900], [50.0000, 0.0009, -2.4900], 4.8045],
  [[50.0000, -0.0010, 2.4900], [50.0000, 0.0010, -2.4900], 4.8045],
  [[50.0000, -0.0010, 2.4900], [50.0000, 0.0011, -2.4900], 4.7461],
  [[50.0000, 2.5000, 0.0000], [50.0000, 0.0000, -2.5000], 4.3065],
  [[50.0000, 2.5000, 0.0000], [73.0000, 25.0000, -18.0000], 27.1492],
  [[50.0000, 2.5000, 0.0000], [61.0000, -5.0000, 29.0000], 22.8977],
  [[50.0000, 2.5000, 0.0000], [56.0000, -27.0000, -3.0000], 31.9030],
  [[50.0000, 2.5000, 0.0000], [58.0000, 24.0000, 15.0000], 19.4535],
  [[50.0000, 2.5000, 0.0000], [50.0000, 3.1736, 0.5854], 1.0000],
  [[50.0000, 2.5000, 0.0000], [50.0000, 3.2972, 0.0000], 1.0000],
  [[50.0000, 2.5000, 0.0000], [50.0000, 1.8634, 0.5757], 1.0000],
  [[50.0000, 2.5000, 0.0000], [50.0000, 3.2592, 0.3350], 1.0000],
  [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
  [[63.0109, -31.0961, -5.8663], [62.8187, -29.7946, -4.0864], 1.2630],
  [[61.2901, 3.7196, -5.3901], [61.4292, 2.2480, -4.9620], 1.8731],
  [[35.0831, -44.1164, 3.7933], [35.0232, -40.0716, 1.5901], 1.8645],
  [[22.7233, 20.0904, -46.6940], [23.0331, 14.9730, -42.5619], 2.0373],
  [[36.4612, 47.8580, 18.3852], [36.2715, 50.5065, 21.2231], 1.4146],
  [[90.8027, -2.0831, 1.4410], [91.1528, -1.6435, 0.0447], 1.4441],
  [[90.9257, -0.5406, -0.9208], [88.6381, -0.8985, -0.7239], 1.5381],
  [[6.7747, -0.2908, -2.4247], [5.8714, -0.0985, -2.2286], 0.6377],
  [[2.0776, 0.0795, -1.1350], [0.9033, -0.0636, -0.5514], 0.9082],
]);

function lab([L, a, b]) {
  return { L, a, b };
}

test('reproduces all 34 published CIEDE2000 reference pairs to four decimals', () => {
  const failures = [];

  REFERENCE_PAIRS.forEach(([first, second, expected], index) => {
    const actual = deltaE2000(lab(first), lab(second));
    if (Math.abs(actual - expected) > 5e-5) {
      failures.push(`pair ${index + 1}: expected ${expected}, got ${actual.toFixed(4)}`);
    }
  });

  assert.deepEqual(failures, [], `CIEDE2000 disagrees with the published data:\n${failures.join('\n')}`);
  assert.equal(REFERENCE_PAIRS.length, 34, 'the reference dataset has 34 pairs');
});

test('CIEDE2000 is symmetric and zero for identical colours across the reference set', () => {
  for (const [first, second] of REFERENCE_PAIRS) {
    const forward = deltaE2000(lab(first), lab(second));
    const backward = deltaE2000(lab(second), lab(first));
    assert.ok(Math.abs(forward - backward) < 1e-12, `asymmetric for ${first} vs ${second}`);
    assert.equal(deltaE2000(lab(first), lab(first)), 0);
  }
});

test('anchors the sRGB/D65 conversion on values with published expectations', () => {
  const white = srgbToLab(255, 255, 255);
  assert.ok(Math.abs(white.L - 100) < 1e-4, `white L* was ${white.L}`);
  assert.ok(Math.abs(white.a) < 1e-4 && Math.abs(white.b) < 1e-4, 'white must be achromatic');

  const black = srgbToLab(0, 0, 0);
  assert.deepEqual(black, { L: 0, a: 0, b: 0 });

  // sRGB 128 grey is the standard spot check for the transfer function: getting
  // 50 here instead means the code linearised with a plain 2.2 power law, or not
  // at all.
  const grey = srgbToLab(128, 128, 128);
  assert.ok(Math.abs(grey.L - 53.5850) < 1e-3, `mid grey L* was ${grey.L}`);

  // Pure sRGB red, D65, 2-degree observer.
  const red = srgbToLab(255, 0, 0);
  assert.ok(Math.abs(red.L - 53.2408) < 1e-3, `red L* was ${red.L}`);
  assert.ok(Math.abs(red.a - 80.0925) < 1e-2, `red a* was ${red.a}`);
  assert.ok(Math.abs(red.b - 67.2032) < 1e-2, `red b* was ${red.b}`);
});

test('one 8-bit step is below the just-noticeable difference in the mid range', () => {
  // Not a tolerance claim, a sanity claim: if a single least-significant bit of
  // an sRGB channel registered as perceptible, every threshold built on this
  // module would be meaningless.
  const step = deltaE2000Srgb({ r: 128, g: 128, b: 128 }, { r: 129, g: 128, b: 128 });
  assert.ok(step > 0, 'a one-step change must be measurable');
  assert.ok(step < JUST_NOTICEABLE_DELTA_E, `one channel step measured ${step}`);
});

test('the per-channel tolerance radius varies enormously across the gamut', () => {
  // This is the measurement that justifies refusing a single default CIEDE2000
  // tolerance for brand-colour comparison: the same +/-3-per-channel tolerance
  // that mechanical.mjs derives from measured runs spans an order of magnitude
  // in CIEDE2000 terms depending on where the colour sits. Small on saturated
  // red, where the chroma weighting S_C is large; largest on dark near-neutrals,
  // where it is not.
  const onRed = deltaERadiusForChannelTolerance({ r: 255, g: 0, b: 0 }, 3);
  const onDark = deltaERadiusForChannelTolerance({ r: 25, g: 25, b: 20 }, 3);

  assert.ok(onRed < 1, `+/-3 on saturated red measured ${onRed.toFixed(4)}`);
  assert.ok(onDark > 6, `+/-3 on a dark near-neutral measured ${onDark.toFixed(4)}`);
  assert.ok(onDark / onRed > 8, 'the radius must differ by close to an order of magnitude');

  assert.equal(deltaERadiusForChannelTolerance({ r: 10, g: 20, b: 30 }, 0), 0);
  assert.throws(() => deltaERadiusForChannelTolerance({ r: 0, g: 0, b: 0 }, 1.5), /integer/);
});
