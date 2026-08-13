/**
 * DCT perceptual hash, and Hamming distance between hashes.
 *
 * Definition, fixed so that a stored hash keeps meaning:
 *
 *   1. decode to a 32x32 sample (aspect discarded, lanczos3 — see pixels.mjs);
 *   2. BT.601 luma over the gamma-encoded channels;
 *   3. 2-D DCT-II;
 *   4. take the 8x8 block at offset (1,1) — the DC row and column are excluded
 *      outright, following pHash's own construction, because the DC term encodes
 *      mean brightness and would otherwise spend a bit on a value that is
 *      effectively constant;
 *   5. bit u*8+v is 1 when that coefficient exceeds the median of all 64,
 *      row-major, most significant bit first;
 *   6. render as 16 lowercase hex characters.
 *
 * WHAT THIS IS NOT. pHash's own documentation is explicit that a DCT hash is not
 * semantically meaningful, and the distance threshold it publishes was derived
 * from its corpus, not this one. So this module ships the *distance* and
 * deliberately ships no threshold: `findDuplicates` requires the caller to pass
 * one, and there is no default to fall back to. See
 * docs/evidence/heuristic-calibration.md for the measured separation on a
 * generated corpus and for why that measurement is not sufficient to bless a
 * number as the project default.
 */

import { PHASH_SAMPLE_EDGE, loadBoundedSample, lumaSample } from './pixels.mjs';

export const PHASH_BITS = 64;
export const PHASH_BLOCK_EDGE = 8;
/** The DCT row and column that are skipped (index 0 is the DC term). */
export const PHASH_BLOCK_OFFSET = 1;
export const PHASH_HEX_LENGTH = PHASH_BITS / 4;

const HEX_PATTERN = /^[0-9a-f]{16}$/;

const NIBBLE_BITS = Object.freeze(
  Array.from({ length: 16 }, (_, value) => (value.toString(2).match(/1/g) ?? []).length),
);

/**
 * Cosine basis for a length-N DCT-II, restricted to the output indices we use.
 * Unnormalised: every coefficient shares the same scale factor, and the hash only
 * compares coefficients with each other.
 */
function cosineBasis(n, indices) {
  return indices.map((k) =>
    Float64Array.from({ length: n }, (_, x) => Math.cos((Math.PI * (x + 0.5) * k) / n)),
  );
}

const BLOCK_INDICES = Object.freeze(
  Array.from({ length: PHASH_BLOCK_EDGE }, (_, i) => i + PHASH_BLOCK_OFFSET),
);
const BASIS = cosineBasis(PHASH_SAMPLE_EDGE, BLOCK_INDICES);

/**
 * The 8x8 low-frequency DCT block of a 32x32 luma grid.
 *
 * Only the 8 output frequencies that the hash uses are transformed, in each
 * dimension, so the whole thing is ~10k multiply-adds rather than a full 32x32
 * transform.
 */
export function lowFrequencyBlock({ luma, width, height }) {
  if (width !== PHASH_SAMPLE_EDGE || height !== PHASH_SAMPLE_EDGE) {
    throw new Error(`the perceptual hash requires a ${PHASH_SAMPLE_EDGE}x${PHASH_SAMPLE_EDGE} luma sample`);
  }

  // Rows first: intermediate[y][v] for the 8 retained horizontal frequencies.
  const intermediate = new Float64Array(PHASH_SAMPLE_EDGE * PHASH_BLOCK_EDGE);
  for (let y = 0; y < PHASH_SAMPLE_EDGE; y += 1) {
    const rowStart = y * PHASH_SAMPLE_EDGE;
    for (let v = 0; v < PHASH_BLOCK_EDGE; v += 1) {
      const basis = BASIS[v];
      let sum = 0;
      for (let x = 0; x < PHASH_SAMPLE_EDGE; x += 1) sum += luma[rowStart + x] * basis[x];
      intermediate[y * PHASH_BLOCK_EDGE + v] = sum;
    }
  }

  const block = new Float64Array(PHASH_BLOCK_EDGE * PHASH_BLOCK_EDGE);
  for (let u = 0; u < PHASH_BLOCK_EDGE; u += 1) {
    const basis = BASIS[u];
    for (let v = 0; v < PHASH_BLOCK_EDGE; v += 1) {
      let sum = 0;
      for (let y = 0; y < PHASH_SAMPLE_EDGE; y += 1) sum += intermediate[y * PHASH_BLOCK_EDGE + v] * basis[y];
      block[u * PHASH_BLOCK_EDGE + v] = sum;
    }
  }

  return block;
}

function medianOf(values) {
  const sorted = Float64Array.from(values).sort();
  const middle = sorted.length / 2;
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Below this spread across the 64 coefficients the block carries no signal.
 *
 * A perfectly uniform frame has AC coefficients that are algebraically zero but
 * numerically ~1e-13, and comparing those against their own median turns
 * floating-point rounding into 64 arbitrary bits. Without this guard a solid
 * white frame and a solid grey frame get different, meaningless hashes that vary
 * with nothing but summation order. Real content produces coefficient spreads of
 * order 1e2 to 1e5, so the cutoff is nowhere near anything meaningful.
 */
export const DEGENERATE_BLOCK_SPREAD = 1e-6;

/** Hash a 32x32 luma sample. Returns 16 lowercase hex characters. */
export function perceptualHashFromLuma(sample) {
  const block = lowFrequencyBlock(sample);

  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (const value of block) {
    if (value < low) low = value;
    if (value > high) high = value;
  }
  if (high - low <= DEGENERATE_BLOCK_SPREAD) return '0'.repeat(PHASH_HEX_LENGTH);

  const median = medianOf(block);

  let hex = '';
  for (let nibble = 0; nibble < PHASH_HEX_LENGTH; nibble += 1) {
    let value = 0;
    for (let bit = 0; bit < 4; bit += 1) {
      value = (value << 1) | (block[nibble * 4 + bit] > median ? 1 : 0);
    }
    hex += value.toString(16);
  }
  return hex;
}

export function assertPerceptualHash(hash, label = 'perceptual hash') {
  if (typeof hash !== 'string' || !HEX_PATTERN.test(hash)) {
    throw new Error(`${label} must be ${PHASH_HEX_LENGTH} lowercase hex characters`);
  }
  return hash;
}

/**
 * Hamming distance between two hashes, 0..64. Computed on the hex form so a
 * stored corpus never has to be parsed into numbers.
 */
export function hammingDistance(a, b) {
  assertPerceptualHash(a, 'the first perceptual hash');
  assertPerceptualHash(b, 'the second perceptual hash');
  let distance = 0;
  for (let i = 0; i < PHASH_HEX_LENGTH; i += 1) {
    distance += NIBBLE_BITS[Number.parseInt(a[i], 16) ^ Number.parseInt(b[i], 16)];
  }
  return distance;
}

/** Decode `filePath` boundedly and hash it. Requires an injected decoder. */
export async function perceptualHash(sharp, filePath, { background } = {}) {
  const sample = await loadBoundedSample(sharp, filePath, PHASH_SAMPLE_EDGE);
  return perceptualHashFromLuma(lumaSample(sample, { background }));
}

/**
 * Nearest corpus entry by Hamming distance, or `null` for an empty corpus.
 * Ties resolve to the earliest entry, so the answer is order-deterministic.
 */
export function nearestHash(hash, corpus) {
  assertPerceptualHash(hash);
  let best = null;
  for (const entry of corpus) {
    const distance = hammingDistance(hash, assertPerceptualHash(entry.hash, `corpus hash for ${entry.id}`));
    if (best === null || distance < best.distance) best = { id: entry.id, hash: entry.hash, distance };
  }
  return best;
}

/**
 * Corpus entries within `maxDistance` of `hash`, nearest first.
 *
 * `maxDistance` is required and has no default. That is the whole point: a
 * threshold nobody calibrated is not a threshold, and silently supplying one
 * would turn an uncalibrated guess into project behaviour. Callers that have no
 * calibrated number should report the distance from `nearestHash` and let a human
 * or a model decide.
 */
export function findDuplicates(hash, corpus, { maxDistance } = {}) {
  if (!Number.isInteger(maxDistance) || maxDistance < 0 || maxDistance > PHASH_BITS) {
    throw new Error(
      'findDuplicates requires an explicit integer maxDistance from 0 to 64; '
        + 'there is no calibrated default (see docs/evidence/heuristic-calibration.md)',
    );
  }
  assertPerceptualHash(hash);
  return corpus
    .map((entry) => ({
      id: entry.id,
      hash: assertPerceptualHash(entry.hash, `corpus hash for ${entry.id}`),
      distance: hammingDistance(hash, entry.hash),
    }))
    .filter((entry) => entry.distance <= maxDistance)
    .sort((left, right) => left.distance - right.distance || String(left.id).localeCompare(String(right.id)));
}
