/**
 * The heuristic prefilter tier.
 *
 * These are prefilters, not verdicts. Their only job is to kill an obviously
 * failed candidate before a model is paid to look at it. That asymmetry is baked
 * into the vocabulary: a prefilter can say REJECT, or it can say it has nothing
 * to add, or it can say it could not run. There is deliberately no PASS —
 * "nothing here looked wrong to a formula" is not evidence that an artifact meets
 * its spec, and giving that state a name is how it would eventually be read as
 * one.
 *
 * `sharp` is optional and arrives injected, the same seam the mechanical tier
 * uses. Without it every signal here is SKIP, explicitly and individually, never
 * silently.
 *
 * Nothing in this module is wired into a CLI command or a spec key; that is a
 * separate slice, and until then these functions have no effect on any exit code.
 */

import { hexToRgb, normaliseHex } from '../verification/mechanical.mjs';
import {
  PALETTE_SAMPLE_EDGE,
  SKIP_REASON_NO_DECODER,
  UNIFORMITY_SAMPLE_EDGE,
  flattenSample,
  loadBoundedSample,
  lumaSample,
  PHASH_SAMPLE_EDGE,
} from './pixels.mjs';
import { DEFAULT_PALETTE_SIZE, brandColorCoverage, brandPaletteDistance, dominantPalette } from './palette.mjs';
import { PHASH_BITS, findDuplicates, nearestHash, perceptualHashFromLuma } from './phash.mjs';
import { measureUniformity } from './uniformity.mjs';

/** A prefilter kills a candidate or stays out of the way. It never accepts one. */
export const REJECT = 'REJECT';
export const INCONCLUSIVE = 'INCONCLUSIVE';
export const SKIP = 'SKIP';
export const PREFILTER_OUTCOMES = Object.freeze([REJECT, INCONCLUSIVE, SKIP]);

function signal(name, outcome, measurement, detail) {
  if (!PREFILTER_OUTCOMES.includes(outcome)) {
    throw new Error(`a prefilter outcome must be one of ${PREFILTER_OUTCOMES.join(', ')}`);
  }
  return { name, outcome, measurement, detail };
}

function skipped(name) {
  return signal(name, SKIP, null, SKIP_REASON_NO_DECODER);
}

function parseBrandColors(colors) {
  if (!Array.isArray(colors) || colors.length === 0) {
    throw new Error('brand.colors must be a non-empty array of #RRGGBB strings');
  }
  return colors.map((color, index) => hexToRgb(normaliseHex(color, `brand.colors[${index}]`)));
}

function assertCorpus(corpus) {
  if (!Array.isArray(corpus)) throw new Error('duplicates.corpus must be an array of { id, hash }');
  return corpus;
}

/**
 * Run the requested prefilters over one file.
 *
 * Each analysis is opt-in, because each one costs a decode. The samples are keyed
 * by edge length and reused, so asking for all three prefilters decodes at three
 * bounded sizes rather than once per question.
 */
export async function runPrefilters(filePath, {
  sharp = null,
  background,
  blank = true,
  palette = false,
  brand = null,
  duplicates = null,
} = {}) {
  const signals = [];
  const notes = [];

  const samples = new Map();
  async function sampleAt(edge) {
    if (!samples.has(edge)) samples.set(edge, await loadBoundedSample(sharp, filePath, edge));
    return samples.get(edge);
  }
  const flattened = new Map();
  async function flatAt(edge) {
    if (!flattened.has(edge)) flattened.set(edge, flattenSample(await sampleAt(edge), { background }));
    return flattened.get(edge);
  }

  const wantsPalette = palette !== false || brand !== null;

  if (blank) {
    if (!sharp) {
      signals.push(skipped('blank'));
    } else {
      const { rgb, dropped, count } = await flatAt(UNIFORMITY_SAMPLE_EDGE);
      const measurement = measureUniformity(rgb);
      if (count === 0) {
        // A fully transparent frame has no colour to compare, and "no visible
        // content at all" is precisely what this prefilter is for.
        signals.push(signal(
          'blank',
          REJECT,
          { pixels: 0, transparentPixels: dropped },
          'every sampled pixel is fully transparent',
        ));
      } else {
        signals.push(signal(
          'blank',
          measurement.nearUniform ? REJECT : INCONCLUSIVE,
          measurement,
          measurement.nearUniform
            ? `no sampled pixel differs from ${measurement.meanHex} by more than a just-noticeable `
              + `difference (max ΔE00 ${measurement.maxDeltaE.toFixed(3)})`
            : `visible variation present (max ΔE00 ${measurement.maxDeltaE.toFixed(3)})`,
        ));
      }
    }
  }

  if (wantsPalette) {
    if (!sharp) {
      if (palette !== false) signals.push(skipped('palette'));
      if (brand !== null) signals.push(skipped('brand-palette'));
    } else {
      const { rgb } = await flatAt(PALETTE_SAMPLE_EDGE);
      const size = palette === true || palette === false ? DEFAULT_PALETTE_SIZE : palette;
      const dominant = dominantPalette(rgb, size, { channelTolerance: brand?.channelTolerance });

      if (palette !== false) {
        // Descriptive only: a palette is never grounds to reject anything.
        signals.push(signal(
          'palette',
          INCONCLUSIVE,
          { entries: dominant },
          `dominant colours: ${dominant.map((entry) => `${entry.hex} ${(entry.share * 100).toFixed(1)}%`).join(', ')}`,
        ));
      }

      if (brand !== null) {
        const colors = parseBrandColors(brand.colors);
        const coverage = brandColorCoverage(rgb, colors, { channelTolerance: brand.channelTolerance });
        const nearestDominant = brandPaletteDistance(dominant, colors);
        const missing = coverage.filter((entry) => !entry.present);
        signals.push(signal(
          'brand-palette',
          missing.length > 0 ? REJECT : INCONCLUSIVE,
          { coverage, nearestDominant },
          missing.length > 0
            ? `no pixel within tolerance of ${missing.map((entry) => entry.hex).join(', ')}`
            : 'every brand colour appears somewhere in the sample',
        ));
      }
    }
  }

  if (duplicates !== null) {
    if (!sharp) {
      signals.push(skipped('duplicate'));
    } else {
      const corpus = assertCorpus(duplicates.corpus ?? []);
      const hash = perceptualHashFromLuma(lumaSample(await sampleAt(PHASH_SAMPLE_EDGE), { background }));
      const nearest = nearestHash(hash, corpus);
      const { maxDistance } = duplicates;

      if (maxDistance === undefined) {
        // No calibrated project threshold exists, so with none configured this
        // reports the distance and stops. It does not pick a number.
        signals.push(signal('duplicate', INCONCLUSIVE, { hash, nearest, maxDistance: null },
          nearest === null
            ? `hash ${hash}; corpus is empty`
            : `hash ${hash}; nearest is ${nearest.id} at Hamming ${nearest.distance}/${PHASH_BITS}; `
              + 'no duplicate threshold configured, so no decision was taken'));
        notes.push(
          'The duplicate prefilter reported a distance only: this project ships no calibrated '
          + 'pHash threshold (see docs/evidence/heuristic-calibration.md).',
        );
      } else {
        const matches = findDuplicates(hash, corpus, { maxDistance });
        signals.push(signal(
          'duplicate',
          matches.length > 0 ? REJECT : INCONCLUSIVE,
          { hash, nearest, matches, maxDistance },
          matches.length > 0
            ? `matches ${matches.map((match) => `${match.id} at ${match.distance}`).join(', ')} `
              + `within the caller-supplied maxDistance ${maxDistance}`
            : `nearest ${nearest === null ? 'n/a' : `${nearest.id} at ${nearest.distance}`} `
              + `exceeds the caller-supplied maxDistance ${maxDistance}`,
        ));
      }
    }
  }

  if (!sharp) {
    notes.push('sharp is unavailable; every heuristic prefilter needs raw pixels and was skipped.');
  }

  return {
    file: filePath,
    degraded: !sharp,
    signals,
    rejected: signals.some((entry) => entry.outcome === REJECT),
    skipped: signals.filter((entry) => entry.outcome === SKIP).length,
    notes,
  };
}

// Re-exported explicitly rather than with `export *`, so the tier's public
// surface is a list someone can read rather than whatever the submodules happen
// to expose.
export { PALETTE_SAMPLE_EDGE, PHASH_SAMPLE_EDGE, SKIP_REASON_NO_DECODER, UNIFORMITY_SAMPLE_EDGE };
export { JUST_NOTICEABLE_DELTA_E, deltaE2000, deltaE2000Srgb, srgbToLab } from './color.mjs';
export {
  PHASH_BITS,
  findDuplicates,
  hammingDistance,
  nearestHash,
  perceptualHash,
  perceptualHashFromLuma,
} from './phash.mjs';
export {
  DEFAULT_CHANNEL_TOLERANCE,
  DEFAULT_PALETTE_SIZE,
  brandColorCoverage,
  brandPaletteDistance,
  deltaERadiusForChannelTolerance,
  dominantPalette,
} from './palette.mjs';
export { NEAR_UNIFORM_MAX_DELTA_E, measureUniformity } from './uniformity.mjs';
