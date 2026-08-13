import assert from 'node:assert/strict';
import { copyFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { loadSharpDecoder } from '../core/verification/inspect.mjs';
import {
  PHASH_BITS,
  findDuplicates,
  hammingDistance,
  nearestHash,
  perceptualHash,
  perceptualHashFromLuma,
} from '../core/heuristics/phash.mjs';
import { PHASH_SAMPLE_EDGE } from '../core/heuristics/pixels.mjs';
import { removeTemporaryDirectory, temporaryDirectory } from './helpers/compat-harness.mjs';
import {
  blankScene,
  ringScene,
  structuredScene,
  stripedScene,
  writeScene,
} from './helpers/heuristic-fixtures.mjs';

/**
 * Distance bounds asserted here are *properties*, not the project's duplicate
 * threshold. They are loose on purpose: the point is that re-encoding and
 * rescaling stay near zero while unrelated content stays far away, with a wide
 * band of nothing in between. Turning that band into an acceptance threshold
 * would need a corpus of real generative output, which these procedural fixtures
 * are not — see docs/evidence/heuristic-calibration.md.
 */
const NEAR = 6;
const FAR = 20;

async function decoder() {
  const { sharp } = await loadSharpDecoder();
  return sharp;
}

test('a uniform luma grid hashes to zero, so blank frames are indistinguishable to pHash', () => {
  const flat = (value) => ({
    luma: Float64Array.from({ length: PHASH_SAMPLE_EDGE * PHASH_SAMPLE_EDGE }, () => value),
    width: PHASH_SAMPLE_EDGE,
    height: PHASH_SAMPLE_EDGE,
  });

  // Every AC coefficient of a constant field is zero, so all 64 bits compare
  // equal to the median and clear. This is a real limitation and the reason
  // blank detection is a separate prefilter rather than a pHash special case:
  // a black frame and a white frame have the *same* perceptual hash.
  assert.equal(perceptualHashFromLuma(flat(0)), '0000000000000000');
  assert.equal(perceptualHashFromLuma(flat(255)), '0000000000000000');
  assert.equal(hammingDistance(perceptualHashFromLuma(flat(12)), perceptualHashFromLuma(flat(240))), 0);
});

test('rejects a luma sample that is not the fixed hash size', () => {
  assert.throws(
    () => perceptualHashFromLuma({ luma: new Float64Array(16), width: 4, height: 4 }),
    /32x32 luma sample/,
  );
});

test('hashes identically for the same bytes and for a lossless re-encode', async () => {
  const sharp = await decoder();
  const root = await temporaryDirectory('pixelproof-phash-identity-');
  try {
    const original = await writeScene(root, 'scene.png', structuredScene());
    const duplicate = path.join(root, 'scene-copy.png');
    await copyFile(original, duplicate);

    if (!sharp) {
      // The documented degraded behaviour, asserted rather than skipped: without
      // a decoder there is no hash at all, and the caller is told so.
      await assert.rejects(() => perceptualHash(sharp, original), /requires a decoder/);
      return;
    }

    const first = await perceptualHash(sharp, original);
    assert.match(first, /^[0-9a-f]{16}$/);
    assert.equal(await perceptualHash(sharp, original), first, 'hashing is deterministic');
    assert.equal(await perceptualHash(sharp, duplicate), first, 'identical bytes hash identically');

    const recompressed = path.join(root, 'scene-recompressed.png');
    await sharp(original).png({ compressionLevel: 1 }).toFile(recompressed);
    assert.equal(await perceptualHash(sharp, recompressed), first, 'a lossless re-encode is bit-identical');
  } finally {
    await removeTemporaryDirectory(root);
  }
});

test('stays close under lossy re-encode and rescale, and far from unrelated content', async () => {
  const sharp = await decoder();
  const root = await temporaryDirectory('pixelproof-phash-properties-');
  try {
    const original = await writeScene(root, 'scene.png', structuredScene());
    const striped = await writeScene(root, 'striped.png', stripedScene());
    const rings = await writeScene(root, 'rings.png', ringScene());

    if (!sharp) {
      await assert.rejects(() => perceptualHash(sharp, original), /requires a decoder/);
      return;
    }

    const base = await perceptualHash(sharp, original);

    const derived = {};
    for (const [name, pipeline] of Object.entries({
      'jpeg-q40': sharp(original).jpeg({ quality: 40 }),
      'jpeg-q70': sharp(original).jpeg({ quality: 70 }),
      'downscale-256': sharp(original).resize(256, 256),
      'downscale-460': sharp(original).resize(460, 460),
      'upscale-1024': sharp(original).resize(1024, 1024),
    })) {
      const target = path.join(root, `${name}${name.startsWith('jpeg') ? '.jpg' : '.png'}`);
      await pipeline.toFile(target);
      derived[name] = hammingDistance(base, await perceptualHash(sharp, target));
    }

    for (const [name, distance] of Object.entries(derived)) {
      assert.ok(distance <= NEAR, `${name} drifted to Hamming ${distance}, above the ${NEAR}-bit property bound`);
    }

    const unrelated = {
      striped: hammingDistance(base, await perceptualHash(sharp, striped)),
      rings: hammingDistance(base, await perceptualHash(sharp, rings)),
    };
    for (const [name, distance] of Object.entries(unrelated)) {
      assert.ok(distance >= FAR, `unrelated fixture ${name} was only ${distance} bits away`);
    }

    assert.ok(
      Math.max(...Object.values(derived)) < Math.min(...Object.values(unrelated)),
      `transformed and unrelated distances overlap: ${JSON.stringify({ derived, unrelated })}`,
    );
  } finally {
    await removeTemporaryDirectory(root);
  }
});

test('distinguishes a near-blank frame from a solid one only via content, not brightness', async () => {
  const sharp = await decoder();
  const root = await temporaryDirectory('pixelproof-phash-blank-');
  try {
    const white = await writeScene(root, 'white.png', blankScene([255, 255, 255, 255]));
    const grey = await writeScene(root, 'grey.png', blankScene([128, 128, 128, 255]));
    const marked = await writeScene(root, 'marked.png', blankScene([255, 255, 255, 255], {
      x: 0.5,
      y: 0.5,
      radius: 0.2,
      color: [0, 0, 0, 255],
    }));

    if (!sharp) {
      await assert.rejects(() => perceptualHash(sharp, white), /requires a decoder/);
      return;
    }

    assert.equal(await perceptualHash(sharp, white), await perceptualHash(sharp, grey));
    assert.notEqual(await perceptualHash(sharp, white), await perceptualHash(sharp, marked));
  } finally {
    await removeTemporaryDirectory(root);
  }
});

test('Hamming distance is a metric over well-formed hashes and validates its inputs', () => {
  const zero = '0'.repeat(16);
  const ones = 'f'.repeat(16);
  assert.equal(hammingDistance(zero, zero), 0);
  assert.equal(hammingDistance(zero, ones), PHASH_BITS);
  assert.equal(hammingDistance(ones, zero), PHASH_BITS);
  assert.equal(hammingDistance('0f0f0f0f0f0f0f0f', zero), 32);

  assert.throws(() => hammingDistance('ABC', zero), /16 lowercase hex characters/);
  assert.throws(() => hammingDistance(zero, '778D8981660FCDF0'), /16 lowercase hex characters/);
  assert.throws(() => hammingDistance(zero, 12), /16 lowercase hex characters/);
});

test('refuses to look for duplicates without an explicit, caller-supplied threshold', () => {
  const corpus = [
    { id: 'accepted-1', hash: '778d8981660fcdf0' },
    { id: 'accepted-2', hash: '565656565656a9a9' },
  ];
  const query = '778d8981660fcdf1';

  // No default. This is the design constraint, not an oversight: a threshold
  // nobody calibrated is not a threshold.
  assert.throws(() => findDuplicates(query, corpus), /explicit integer maxDistance/);
  assert.throws(() => findDuplicates(query, corpus, { maxDistance: 2.5 }), /explicit integer maxDistance/);
  assert.throws(() => findDuplicates(query, corpus, { maxDistance: 65 }), /explicit integer maxDistance/);

  assert.deepEqual(findDuplicates(query, corpus, { maxDistance: 0 }), []);
  assert.deepEqual(
    findDuplicates(query, corpus, { maxDistance: 4 }).map(({ id, distance }) => ({ id, distance })),
    [{ id: 'accepted-1', distance: 1 }],
  );

  assert.deepEqual(nearestHash(query, corpus), { id: 'accepted-1', hash: '778d8981660fcdf0', distance: 1 });
  assert.equal(nearestHash(query, []), null);
});
