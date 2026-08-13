import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadSharpDecoder } from '../core/verification/inspect.mjs';
import {
  INCONCLUSIVE,
  PREFILTER_OUTCOMES,
  REJECT,
  SKIP,
  runPrefilters,
} from '../core/heuristics/index.mjs';
import { brandColorCoverage, dominantPalette } from '../core/heuristics/palette.mjs';
import { flattenSample, loadBoundedSample, PALETTE_SAMPLE_EDGE } from '../core/heuristics/pixels.mjs';
import { measureUniformity } from '../core/heuristics/uniformity.mjs';
import { perceptualHash } from '../core/heuristics/phash.mjs';
import { removeTemporaryDirectory, temporaryDirectory } from './helpers/compat-harness.mjs';
import { blankScene, ringScene, structuredScene, writeScene } from './helpers/heuristic-fixtures.mjs';

const HEURISTICS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'core',
  'heuristics',
);

async function decoder() {
  const { sharp } = await loadSharpDecoder();
  return sharp;
}

/** Three bands: half red, a quarter green, a quarter blue. */
function bandedScene(edge = 512) {
  return (x, y) => {
    const v = y / edge;
    if (v < 0.5) return [255, 0, 0, 255];
    if (v < 0.75) return [0, 255, 0, 255];
    return [0, 0, 255, 255];
  };
}

function outcomesOf(result) {
  return Object.fromEntries(result.signals.map((entry) => [entry.name, entry.outcome]));
}

test('the prefilter vocabulary has no accepting outcome, in the API or in the source', () => {
  assert.deepEqual([...PREFILTER_OUTCOMES], ['REJECT', 'INCONCLUSIVE', 'SKIP']);

  // A source-level guard, because the constraint is architectural rather than
  // behavioural: nothing under core/heuristics/ may ever hand back a PASS, and a
  // future edit that introduces one should fail here rather than in review.
  const offenders = [];
  for (const entry of readdirSync(HEURISTICS_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.mjs')) continue;
    const source = readFileSync(path.join(HEURISTICS_DIR, entry.name), 'utf8');
    // Strip block comments: the prose explains *why* there is no PASS.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const forbidden of [/\bPASS\b/, /\bACCEPT(ED)?\b/]) {
      if (forbidden.test(code)) offenders.push(`${entry.name} contains ${forbidden}`);
    }
  }
  assert.deepEqual(offenders, [], `a prefilter must never accept:\n${offenders.join('\n')}`);
});

test('reports every prefilter as SKIP without a decoder, and says so once', async () => {
  const result = await runPrefilters('/nonexistent/never-opened.png', {
    sharp: null,
    palette: true,
    brand: { colors: ['#ff0000'] },
    duplicates: { corpus: [], maxDistance: 4 },
  });

  assert.equal(result.degraded, true);
  assert.deepEqual(outcomesOf(result), {
    blank: SKIP,
    palette: SKIP,
    'brand-palette': SKIP,
    duplicate: SKIP,
  });
  assert.equal(result.skipped, 4);
  assert.equal(result.rejected, false);
  for (const entry of result.signals) {
    assert.equal(entry.detail, 'sharp unavailable');
    assert.equal(entry.measurement, null);
  }
  assert.deepEqual(result.notes, [
    'sharp is unavailable; every heuristic prefilter needs raw pixels and was skipped.',
  ]);
});

test('measures uniformity from just-noticeable difference, not from a guessed number', () => {
  const solid = new Uint8Array(300).fill(200);
  const solidMeasure = measureUniformity(solid);
  assert.equal(solidMeasure.nearUniform, true);
  assert.equal(solidMeasure.maxDeltaE, 0);
  assert.equal(solidMeasure.meanHex, '#c8c8c8');
  assert.equal(solidMeasure.uniformShare, 1);

  // A one-step-per-channel dither is still nothing anybody can see.
  const dithered = Uint8Array.from({ length: 300 }, (_, index) => 200 + (index % 2));
  assert.equal(measureUniformity(dithered).nearUniform, true);

  // A single visibly different pixel is enough to stop it being a blank frame.
  const marked = new Uint8Array(300).fill(200);
  marked[0] = 0;
  marked[1] = 0;
  marked[2] = 0;
  const markedMeasure = measureUniformity(marked);
  assert.equal(markedMeasure.nearUniform, false);
  assert.ok(markedMeasure.maxDeltaE > 40, `expected a large deviation, got ${markedMeasure.maxDeltaE}`);
  assert.ok(markedMeasure.uniformShare > 0.98, 'almost every pixel is still uniform');

  assert.deepEqual(measureUniformity(new Uint8Array(0)), {
    pixels: 0,
    meanHex: null,
    maxDeltaE: null,
    meanDeltaE: null,
    uniformShare: null,
    nearUniform: false,
  });
});

test('extracts a deterministic dominant palette with proportional shares', async () => {
  const sharp = await decoder();
  const root = await temporaryDirectory('pixelproof-palette-');
  try {
    const banded = await writeScene(root, 'banded.png', bandedScene());

    if (!sharp) {
      await assert.rejects(() => loadBoundedSample(sharp, banded, 8), /requires a decoder/);
      return;
    }

    const sample = await loadBoundedSample(sharp, banded, PALETTE_SAMPLE_EDGE);
    const { rgb, count } = flattenSample(sample);
    assert.equal(count, PALETTE_SAMPLE_EDGE * PALETTE_SAMPLE_EDGE);

    const palette = dominantPalette(rgb, 3);
    assert.equal(palette.length, 3);
    assert.equal(palette.reduce((total, entry) => total + entry.pixels, 0), count);
    assert.deepEqual(dominantPalette(rgb, 3), palette, 'extraction must be deterministic');

    const byHue = Object.fromEntries(palette.map((entry) => {
      const { r, g, b } = entry.rgb;
      const dominant = r >= g && r >= b ? 'red' : g >= b ? 'green' : 'blue';
      return [dominant, entry];
    }));
    assert.deepEqual(Object.keys(byHue).sort(), ['blue', 'green', 'red']);
    assert.ok(Math.abs(byHue.red.share - 0.5) < 0.05, `red share was ${byHue.red.share}`);
    assert.ok(Math.abs(byHue.green.share - 0.25) < 0.05, `green share was ${byHue.green.share}`);
    assert.ok(Math.abs(byHue.blue.share - 0.25) < 0.05, `blue share was ${byHue.blue.share}`);

    // Presence is answered against every sampled pixel, not against the
    // clusters, so a colour that is genuinely in the image is found and one that
    // is not stays absent.
    const coverage = brandColorCoverage(rgb, [
      { r: 255, g: 0, b: 0 },
      { r: 255, g: 255, b: 0 },
    ]);
    assert.equal(coverage[0].present, true);
    assert.ok(coverage[0].nearestDeltaE < 1, `red was ${coverage[0].nearestDeltaE} away`);
    assert.ok(coverage[0].share > 0.4, `red covered ${coverage[0].share}`);
    assert.equal(coverage[1].present, false);
    assert.ok(coverage[1].nearestDeltaE > 20, `yellow was only ${coverage[1].nearestDeltaE} away`);
    assert.equal(coverage[1].share, 0);
  } finally {
    await removeTemporaryDirectory(root);
  }
});

test('rejects blank and fully transparent frames, and stays out of the way otherwise', async () => {
  const sharp = await decoder();
  const root = await temporaryDirectory('pixelproof-blank-prefilter-');
  try {
    const solid = await writeScene(root, 'solid.png', blankScene([12, 34, 56, 255]));
    const transparent = await writeScene(root, 'transparent.png', blankScene([0, 0, 0, 0]));
    const scene = await writeScene(root, 'scene.png', structuredScene());
    const faint = await writeScene(root, 'faint.png', blankScene([250, 250, 250, 255], {
      x: 0.5,
      y: 0.5,
      radius: 0.04,
      color: [20, 20, 20, 255],
    }));

    if (!sharp) {
      assert.equal((await runPrefilters(solid, { sharp: null })).signals[0].outcome, SKIP);
      return;
    }

    const solidResult = await runPrefilters(solid, { sharp });
    assert.equal(outcomesOf(solidResult).blank, REJECT);
    assert.equal(solidResult.rejected, true);
    assert.match(solidResult.signals[0].detail, /just-noticeable difference/);
    assert.equal(solidResult.signals[0].measurement.meanHex, '#0c2238');

    const transparentResult = await runPrefilters(transparent, { sharp });
    assert.equal(outcomesOf(transparentResult).blank, REJECT);
    assert.match(transparentResult.signals[0].detail, /fully transparent/);

    const sceneResult = await runPrefilters(scene, { sharp });
    assert.equal(outcomesOf(sceneResult).blank, INCONCLUSIVE);
    assert.equal(sceneResult.rejected, false);

    // A small mark on a near-white field must survive the 256-edge resample;
    // this is the false-reject case that matters most for a killing prefilter.
    const faintResult = await runPrefilters(faint, { sharp });
    assert.equal(outcomesOf(faintResult).blank, INCONCLUSIVE);
    assert.ok(
      faintResult.signals[0].measurement.uniformShare > 0.98,
      'the frame is still overwhelmingly uniform, which is reported rather than acted on',
    );
  } finally {
    await removeTemporaryDirectory(root);
  }
});

test('reports a duplicate distance without a threshold and only rejects with one', async () => {
  const sharp = await decoder();
  const root = await temporaryDirectory('pixelproof-duplicate-prefilter-');
  try {
    const scene = await writeScene(root, 'scene.png', structuredScene());
    const other = await writeScene(root, 'other.png', ringScene());

    if (!sharp) {
      assert.equal((await runPrefilters(scene, { sharp: null, duplicates: { corpus: [] } })).skipped, 2);
      return;
    }

    const knownHash = await perceptualHash(sharp, scene);
    const corpus = [{ id: 'already-accepted', hash: knownHash }];

    const unthresholded = await runPrefilters(scene, { sharp, blank: false, duplicates: { corpus } });
    const [signal] = unthresholded.signals;
    assert.equal(signal.outcome, INCONCLUSIVE);
    assert.equal(unthresholded.rejected, false);
    assert.equal(signal.measurement.maxDistance, null);
    assert.equal(signal.measurement.nearest.distance, 0);
    assert.match(signal.detail, /no duplicate threshold configured/);
    assert.equal(unthresholded.notes.length, 1);
    assert.match(unthresholded.notes[0], /no calibrated\s+pHash threshold/);

    const thresholded = await runPrefilters(scene, {
      sharp,
      blank: false,
      duplicates: { corpus, maxDistance: 0 },
    });
    assert.equal(thresholded.signals[0].outcome, REJECT);
    assert.equal(thresholded.rejected, true);
    assert.match(thresholded.signals[0].detail, /caller-supplied maxDistance 0/);

    const distinct = await runPrefilters(other, {
      sharp,
      blank: false,
      duplicates: { corpus, maxDistance: 0 },
    });
    assert.equal(distinct.signals[0].outcome, INCONCLUSIVE);
  } finally {
    await removeTemporaryDirectory(root);
  }
});

test('reports a brand palette and rejects only a colour that is nowhere in the frame', async () => {
  const sharp = await decoder();
  const root = await temporaryDirectory('pixelproof-brand-prefilter-');
  try {
    const banded = await writeScene(root, 'banded.png', bandedScene());

    if (!sharp) {
      assert.equal((await runPrefilters(banded, { sharp: null, palette: true })).skipped, 2);
      return;
    }

    const present = await runPrefilters(banded, {
      sharp,
      blank: false,
      palette: 3,
      brand: { colors: ['#FF0000', '#0000ff'] },
    });
    assert.deepEqual(outcomesOf(present), { palette: INCONCLUSIVE, 'brand-palette': INCONCLUSIVE });
    assert.equal(present.rejected, false);
    assert.equal(present.signals[0].measurement.entries.length, 3);

    const missing = await runPrefilters(banded, {
      sharp,
      blank: false,
      brand: { colors: ['#ff0000', '#ffff00'] },
    });
    assert.equal(outcomesOf(missing)['brand-palette'], REJECT);
    assert.match(missing.signals[0].detail, /no pixel within tolerance of #ffff00/);

    await assert.rejects(
      () => runPrefilters(banded, { sharp, blank: false, brand: { colors: [] } }),
      /non-empty array/,
    );
    await assert.rejects(
      () => runPrefilters(banded, { sharp, blank: false, brand: { colors: ['red'] } }),
      /#RRGGBB/,
    );
  } finally {
    await removeTemporaryDirectory(root);
  }
});

test('decodes each bounded sample size at most once across all prefilters', async () => {
  const sharp = await decoder();
  const root = await temporaryDirectory('pixelproof-decode-budget-');
  try {
    const scene = await writeScene(root, 'scene.png', structuredScene());
    if (!sharp) {
      assert.equal((await runPrefilters(scene, { sharp: null })).degraded, true);
      return;
    }

    let decodes = 0;
    const counting = (...args) => {
      decodes += 1;
      return sharp(...args);
    };

    const result = await runPrefilters(scene, {
      sharp: counting,
      palette: true,
      brand: { colors: ['#f2f2f0'] },
      duplicates: { corpus: [] },
    });

    // Three analyses at three sample sizes, and the palette and brand signals
    // share one decode rather than taking one each.
    assert.equal(decodes, 3, `expected 3 bounded decodes, saw ${decodes}`);
    assert.equal(result.signals.length, 4);
    for (const entry of result.signals) {
      assert.ok(PREFILTER_OUTCOMES.includes(entry.outcome), `unexpected outcome ${entry.outcome}`);
    }
  } finally {
    await removeTemporaryDirectory(root);
  }
});
