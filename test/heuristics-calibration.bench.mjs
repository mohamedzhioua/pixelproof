/**
 * Calibration and cost evidence for the heuristic prefilters.
 *
 * Not a test — the filename ends in `.bench.mjs` precisely so that `npm test`
 * (which globs `test/*.test.mjs`) does not run it. Run it by hand:
 *
 *   node test/heuristics-calibration.bench.mjs
 *
 * It answers four questions with measurements rather than opinion:
 *
 *   1. how far apart are pHash distances for transformed-same-image versus
 *      different-image pairs, on a corpus this repository can actually generate;
 *   2. what CIEDE2000 radius the project's existing +/-3-per-channel tolerance
 *      corresponds to across the gamut;
 *   3. whether edge/stroke density separates text from texture (it does not,
 *      which is why no text-likelihood check ships);
 *   4. what the prefilters cost at the maximum supported image size.
 *
 * The recorded output lives in docs/evidence/heuristic-calibration.md.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadSharpDecoder } from '../core/verification/inspect.mjs';
import { deltaERadiusForChannelTolerance } from '../core/heuristics/palette.mjs';
import { hammingDistance, perceptualHash } from '../core/heuristics/phash.mjs';
import { PHASH_SAMPLE_EDGE, UNIFORMITY_SAMPLE_EDGE, lumaSample, loadBoundedSample } from '../core/heuristics/pixels.mjs';
import { runPrefilters } from '../core/heuristics/index.mjs';
import { writePng } from './helpers/compat-harness.mjs';

/** Deterministic PRNG so a rerun reproduces the same corpus. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CORPUS_SIZE = 24;
const SCENE_EDGE = 512;

/**
 * A synthetic "design asset": flat background, a few solid shapes, one accent
 * band. Closer to the icons, OG images and app screenshots this tool targets
 * than photographic content would be, and every parameter comes from the seeded
 * PRNG so the corpus is reproducible.
 */
function syntheticAsset(seed) {
  const random = mulberry32(seed);
  const background = [200 + random() * 55, 200 + random() * 55, 195 + random() * 55].map(Math.round);
  const accent = [random() * 255, random() * 255, random() * 255].map(Math.round);
  const shapes = Array.from({ length: 2 + Math.floor(random() * 3) }, () => ({
    cx: 0.15 + random() * 0.7,
    cy: 0.15 + random() * 0.7,
    r: 0.06 + random() * 0.16,
    color: [random() * 200, random() * 200, random() * 200].map(Math.round),
    square: random() < 0.5,
  }));
  const bandTop = 0.6 + random() * 0.3;

  return (x, y) => {
    const u = x / SCENE_EDGE;
    const v = y / SCENE_EDGE;
    if (v > bandTop) return [...accent, 255];
    for (const shape of shapes) {
      if (shape.square) {
        if (Math.abs(u - shape.cx) < shape.r && Math.abs(v - shape.cy) < shape.r) return [...shape.color, 255];
      } else if ((u - shape.cx) ** 2 + (v - shape.cy) ** 2 <= shape.r ** 2) {
        return [...shape.color, 255];
      }
    }
    return [...background, 255];
  };
}

function summarise(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return {
    n: sorted.length,
    min: sorted[0],
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted[sorted.length - 1],
    mean: sorted.reduce((total, value) => total + value, 0) / sorted.length,
  };
}

function row(label, stats) {
  return `${label.padEnd(26)} n=${String(stats.n).padStart(5)}  min=${String(stats.min).padStart(3)}  `
    + `p50=${String(stats.p50).padStart(3)}  p95=${String(stats.p95).padStart(3)}  `
    + `p99=${String(stats.p99).padStart(3)}  max=${String(stats.max).padStart(3)}  `
    + `mean=${stats.mean.toFixed(2)}`;
}

async function phashCalibration(sharp, root) {
  const bases = [];
  for (let seed = 1; seed <= CORPUS_SIZE; seed += 1) {
    const filePath = path.join(root, `asset-${seed}.png`);
    await writePng(filePath, SCENE_EDGE, SCENE_EDGE, { pixel: syntheticAsset(seed) });
    bases.push({ seed, filePath, hash: await perceptualHash(sharp, filePath) });
  }

  const transforms = {
    'png-recompress': (image) => image.png({ compressionLevel: 1 }),
    'jpeg-q90': (image) => image.jpeg({ quality: 90 }),
    'jpeg-q40': (image) => image.jpeg({ quality: 40 }),
    'jpeg-q15': (image) => image.jpeg({ quality: 15 }),
    'scale-0.5x': (image) => image.resize(256, 256),
    'scale-0.9x': (image) => image.resize(460, 460),
    'scale-2x': (image) => image.resize(1024, 1024),
    'brighten-8': (image) => image.modulate({ brightness: 1.08 }),
    'darken-8': (image) => image.modulate({ brightness: 0.92 }),
    'crop-2pct': (image) => image.extract({ left: 5, top: 5, width: 502, height: 502 }),
    'crop-10pct': (image) => image.extract({ left: 26, top: 26, width: 460, height: 460 }),
    'rotate-1deg': (image) => image.rotate(1, { background: '#ffffff' }),
    'blur-1px': (image) => image.blur(1),
  };

  const perTransform = new Map();
  for (const base of bases) {
    for (const [name, apply] of Object.entries(transforms)) {
      const target = path.join(root, `asset-${base.seed}-${name}.${name.startsWith('jpeg') ? 'jpg' : 'png'}`);
      await apply(sharp(base.filePath)).toFile(target);
      const distance = hammingDistance(base.hash, await perceptualHash(sharp, target));
      if (!perTransform.has(name)) perTransform.set(name, []);
      perTransform.get(name).push(distance);
    }
  }

  const inter = [];
  for (let i = 0; i < bases.length; i += 1) {
    for (let j = i + 1; j < bases.length; j += 1) {
      inter.push(hammingDistance(bases[i].hash, bases[j].hash));
    }
  }

  const intra = [...perTransform.values()].flat();

  console.log('\n== 1. pHash separation on a generated corpus ==');
  console.log(`corpus: ${CORPUS_SIZE} synthetic design assets at ${SCENE_EDGE}px, `
    + `${Object.keys(transforms).length} transforms each`);
  for (const [name, values] of perTransform) console.log(row(`  same image / ${name}`, summarise(values)));
  console.log(row('SAME IMAGE (all transforms)', summarise(intra)));
  console.log(row('DIFFERENT IMAGES', summarise(inter)));

  const intraStats = summarise(intra);
  const interStats = summarise(inter);
  console.log(`\ngap: worst same-image distance ${intraStats.max}, `
    + `closest different-image distance ${interStats.min} `
    + `-> ${interStats.min > intraStats.max ? 'separated' : 'OVERLAPPING'}`);
  return { intraStats, interStats, transforms: Object.keys(transforms).length };
}

function toleranceRadiusSweep() {
  console.log('\n== 2. CIEDE2000 radius of the project +/-3-per-channel tolerance ==');
  let worst = { radius: 0, color: null };
  let best = { radius: Infinity, color: null };
  let total = 0;
  let samples = 0;
  for (let r = 0; r <= 255; r += 15) {
    for (let g = 0; g <= 255; g += 15) {
      for (let b = 0; b <= 255; b += 15) {
        const radius = deltaERadiusForChannelTolerance({ r, g, b }, 3);
        total += radius;
        samples += 1;
        if (radius > worst.radius) worst = { radius, color: [r, g, b] };
        if (radius < best.radius) best = { radius, color: [r, g, b] };
      }
    }
  }
  console.log(`sampled ${samples} sRGB colours on a 15-step lattice`);
  console.log(`  min radius ${best.radius.toFixed(4)} at rgb(${best.color})`);
  console.log(`  max radius ${worst.radius.toFixed(4)} at rgb(${worst.color})`);
  console.log(`  mean radius ${(total / samples).toFixed(4)}`);
  for (const color of [[255, 255, 255], [200, 200, 200], [128, 128, 128], [25, 25, 20], [0, 0, 0], [255, 0, 0], [0, 102, 204]]) {
    console.log(`  rgb(${color.join(',')}) -> ${deltaERadiusForChannelTolerance({ r: color[0], g: color[1], b: color[2] }, 3).toFixed(4)}`);
  }
  return { best, worst, mean: total / samples };
}

/**
 * Sobel edge density, implemented here and *only* here. It is deliberately not
 * in core/: this measurement exists to show that the "OCR-free text likelihood"
 * idea does not survive contact with data.
 */
function edgeDensity(luma, width, height, threshold = 48) {
  let above = 0;
  let considered = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const at = (dx, dy) => luma[(y + dy) * width + (x + dx)];
      const gx = -at(-1, -1) - 2 * at(-1, 0) - at(-1, 1) + at(1, -1) + 2 * at(1, 0) + at(1, 1);
      const gy = -at(-1, -1) - 2 * at(0, -1) - at(1, -1) + at(-1, 1) + 2 * at(0, 1) + at(1, 1);
      if (Math.hypot(gx, gy) > threshold) above += 1;
      considered += 1;
    }
  }
  return above / considered;
}

const TEXT_LIKE_SCENES = {
  'paragraph-of-text': (x, y) => {
    // Rows of short dark runs with word gaps and line leading: the coarse
    // structure of body copy.
    const line = Math.floor(y / 22);
    const withinLine = y % 22;
    if (withinLine > 12 || line > 20) return [255, 255, 255, 255];
    const word = Math.floor(x / 37);
    if (x % 37 > 30) return [255, 255, 255, 255];
    return (word + line) % 11 === 3 ? [255, 255, 255, 255] : [25, 25, 25, 255];
  },
  'heading-only': (x, y) => {
    if (y < 180 || y > 260) return [250, 250, 250, 255];
    return x % 46 < 32 && x < 420 ? [20, 20, 20, 255] : [250, 250, 250, 255];
  },
};

const TEXTURE_SCENES = {
  'hatch-texture': (x, y) => ((x + y) % 9 < 4 ? [40, 40, 40, 255] : [245, 245, 245, 255]),
  'brick-texture': (x, y) => {
    const rowIndex = Math.floor(y / 18);
    const offset = rowIndex % 2 ? 22 : 0;
    return y % 18 < 3 || (x + offset) % 44 < 3 ? [70, 60, 55, 255] : [190, 120, 100, 255];
  },
  'foliage-noise': (x, y) => {
    const random = mulberry32(x * 7919 + y * 104729);
    const value = random() > 0.45 ? 40 + random() * 60 : 120 + random() * 90;
    return [value * 0.5, value, value * 0.4, 255].map(Math.round);
  },
  'chart-gridlines': (x, y) => (x % 32 < 2 || y % 32 < 2 ? [120, 120, 120, 255] : [252, 252, 252, 255]),
  'photo-like-gradient': (x, y) => {
    const value = 60 + 150 * Math.abs(Math.sin(x / 90)) * Math.abs(Math.cos(y / 130));
    return [value, value * 0.9, value * 0.8, 255].map(Math.round);
  },
};

async function textLikelihoodProbe(sharp, root) {
  console.log('\n== 3. Edge/stroke density: does it separate text from texture? ==');
  const results = [];
  for (const [group, scenes] of [['text', TEXT_LIKE_SCENES], ['not-text', TEXTURE_SCENES]]) {
    for (const [name, pixel] of Object.entries(scenes)) {
      const filePath = path.join(root, `edge-${name}.png`);
      await writePng(filePath, SCENE_EDGE, SCENE_EDGE, { pixel });
      const sample = await loadBoundedSample(sharp, filePath, UNIFORMITY_SAMPLE_EDGE);
      const { luma, width, height } = lumaSample(sample);
      results.push({ group, name, density: edgeDensity(luma, width, height) });
    }
  }
  results.sort((left, right) => right.density - left.density);
  for (const entry of results) {
    console.log(`  ${entry.density.toFixed(4)}  ${entry.group.padEnd(8)}  ${entry.name}`);
  }
  const textMax = Math.max(...results.filter((entry) => entry.group === 'text').map((entry) => entry.density));
  const textMin = Math.min(...results.filter((entry) => entry.group === 'text').map((entry) => entry.density));
  const others = results.filter((entry) => entry.group === 'not-text');
  const overlapping = others.filter((entry) => entry.density >= textMin && entry.density <= textMax);
  console.log(`\ntext density range [${textMin.toFixed(4)}, ${textMax.toFixed(4)}]; `
    + `non-text scenes inside that range: ${overlapping.map((entry) => entry.name).join(', ') || 'none'}`);
  console.log(`no threshold separates the classes: ${overlapping.length > 0 ? 'CONFIRMED' : 'not shown'}`);
  return { results, overlapping };
}

async function costBenchmark(sharp, root) {
  console.log('\n== 4. Cost at the maximum supported image size ==');
  // Codex's documented size rules cap the longest edge at 3840 (docs/V2-BRIEF.md).
  const sizes = [[3840, 2160], [3840, 3840]];
  const rows = [];
  for (const [width, height] of sizes) {
    const filePath = path.join(root, `large-${width}x${height}.png`);
    await sharp({
      create: { width, height, channels: 4, background: '#ffffff' },
    })
      .composite([
        { input: { create: { width: Math.floor(width / 2), height: Math.floor(height / 3), channels: 4, background: '#1e2a44' } }, left: 40, top: 40 },
        { input: { create: { width: Math.floor(width / 4), height: Math.floor(height / 4), channels: 4, background: '#dc2626' } }, left: Math.floor(width / 2), top: Math.floor(height / 2) },
      ])
      .png()
      .toFile(filePath);

    // Warm the file cache and JIT before measuring.
    await runPrefilters(filePath, { sharp, palette: true, brand: { colors: ['#dc2626'] }, duplicates: { corpus: [] } });

    const runs = 5;
    const timings = { all: [], blank: [], palette: [], duplicate: [] };
    for (let i = 0; i < runs; i += 1) {
      let start = performance.now();
      await runPrefilters(filePath, { sharp, palette: true, brand: { colors: ['#dc2626'] }, duplicates: { corpus: [] } });
      timings.all.push(performance.now() - start);

      start = performance.now();
      await runPrefilters(filePath, { sharp });
      timings.blank.push(performance.now() - start);

      start = performance.now();
      await runPrefilters(filePath, { sharp, blank: false, palette: true });
      timings.palette.push(performance.now() - start);

      start = performance.now();
      await runPrefilters(filePath, { sharp, blank: false, duplicates: { corpus: [] } });
      timings.duplicate.push(performance.now() - start);
    }

    // The pure-JavaScript share: hash a pre-decoded sample repeatedly.
    const sample = await loadBoundedSample(sharp, filePath, PHASH_SAMPLE_EDGE);
    const start = performance.now();
    for (let i = 0; i < 200; i += 1) lumaSample(sample);
    const lumaCost = (performance.now() - start) / 200;

    const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    rows.push({
      size: `${width}x${height}`,
      megapixels: ((width * height) / 1e6).toFixed(1),
      all: median(timings.all),
      blank: median(timings.blank),
      palette: median(timings.palette),
      duplicate: median(timings.duplicate),
      lumaCost,
    });
  }

  for (const entry of rows) {
    console.log(`  ${entry.size} (${entry.megapixels} MP): all three ${entry.all.toFixed(1)} ms | `
      + `blank ${entry.blank.toFixed(1)} ms | palette+brand ${entry.palette.toFixed(1)} ms | `
      + `duplicate ${entry.duplicate.toFixed(1)} ms | luma pass over the 32x32 sample ${entry.lumaCost.toFixed(4)} ms`);
  }
  return rows;
}

async function main() {
  const { sharp, error } = await loadSharpDecoder();
  if (!sharp) {
    console.error(`sharp is unavailable (${error?.code ?? error?.message}); `
      + 'this harness measures raw-pixel behaviour and cannot run degraded.');
    process.exitCode = 1;
    return;
  }

  console.log(`node ${process.version} | sharp ${sharp.versions.sharp} | libvips ${sharp.versions.vips} | `
    + `${os.platform()} ${os.arch()} | ${os.cpus()[0]?.model ?? 'unknown cpu'}`);

  const root = await mkdtemp(path.join(os.tmpdir(), 'pixelproof-calibration-'));
  try {
    await phashCalibration(sharp, root);
    toleranceRadiusSweep();
    await textLikelihoodProbe(sharp, root);
    await costBenchmark(sharp, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await main();
