/**
 * Unit coverage for the generator's extracted core.
 *
 * These are the rules the CLI used to hold privately: dimension precedence,
 * spec validation, prompt folding, and the single-attempt run. They are tested
 * here directly so a later change to the CLI cannot quietly take them with it.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_HEIGHT,
  DEFAULT_WIDTH,
  describeSizeDisagreement,
  parseAspect,
  parseSize,
  positiveInteger,
  resolveDimensions,
} from '../core/spec/dimensions.mjs';
import {
  assertV1Spec,
  loadV1Spec,
  mechanicalBlock,
  semanticAssertions,
  specFromSize,
} from '../core/spec/load-v1.mjs';
import { foldSpecIntoPrompt } from '../core/generation/prompt-v1.mjs';
import { runOnce } from '../core/generation/run-once.mjs';

test('parseSize accepts WxH in either case and rejects anything else', () => {
  assert.deepEqual(parseSize('1254x1254'), { width: 1254, height: 1254 });
  assert.deepEqual(parseSize('1024X768'), { width: 1024, height: 768 });
  assert.equal(parseSize(undefined), null);
  assert.equal(parseSize(''), null);
  assert.throws(() => parseSize('1024'), {
    message: '--size must use the form WxH, for example 1254x1254',
  });
  assert.throws(() => parseSize('1024*768'), { message: /--size must use the form WxH/ });
});

test('positiveInteger rejects zero, negatives, and non-integers', () => {
  assert.equal(positiveInteger('16', 'width'), 16);
  for (const value of ['0', '-4', '1.5', 'abc']) {
    assert.throws(() => positiveInteger(value, 'width'), {
      message: 'width must be a positive integer',
    });
  }
});

test('parseAspect returns a ratio and reports each malformed shape', () => {
  assert.equal(parseAspect('16:9'), 16 / 9);
  assert.equal(parseAspect(' 3 : 2 '), 1.5);
  assert.equal(parseAspect(undefined), null);
  assert.throws(() => parseAspect(9), { message: 'mechanical.aspect must be a string' });
  assert.throws(() => parseAspect('16/9'), {
    message: 'mechanical.aspect must use the form width:height',
  });
  assert.throws(() => parseAspect('0:9'), {
    message: 'mechanical.aspect values must be positive',
  });
});

test('resolveDimensions falls back to the defaults when nothing is declared', () => {
  assert.deepEqual(resolveDimensions(null, {}), {
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
  });
});

test('spec dimensions outrank a requested size', () => {
  const resolved = resolveDimensions({ width: 1024, height: 1024 }, { width: 32, height: 16 });
  assert.deepEqual(resolved, { width: 32, height: 16 });
  assert.equal(
    describeSizeDisagreement({ width: 1024, height: 1024 }, resolved),
    '--size requested 1024x1024, but the spec dimensions are 32x16; '
      + 'the spec is authoritative.',
  );
});

test('an honoured size produces no disagreement notice', () => {
  const resolved = resolveDimensions({ width: 800, height: 600 }, {});
  assert.deepEqual(resolved, { width: 800, height: 600 });
  assert.equal(describeSizeDisagreement({ width: 800, height: 600 }, resolved), null);
  assert.equal(describeSizeDisagreement(null, resolved), null);
});

test('an aspect derives the missing edge only when no size was requested', () => {
  assert.deepEqual(resolveDimensions(null, { width: 1600, aspect: '16:9' }), {
    width: 1600,
    height: 900,
  });
  assert.deepEqual(resolveDimensions(null, { height: 900, aspect: '16:9' }), {
    width: 1600,
    height: 900,
  });
  // A requested size is a complete answer; the aspect only has to agree with it.
  assert.deepEqual(resolveDimensions({ width: 1600, height: 900 }, { aspect: '16:9' }), {
    width: 1600,
    height: 900,
  });
});

test('a self-contradicting spec is rejected rather than generated', () => {
  assert.throws(() => resolveDimensions(null, { width: 100, height: 100, aspect: '16:9' }), {
    message: 'Resolved dimensions 100x100 conflict with spec aspect 16:9',
  });
});

test('assertV1Spec freezes the shape rejections', () => {
  assert.deepEqual(assertV1Spec({}), {});
  assert.throws(() => assertV1Spec([]), { message: 'The spec root must be a JSON object' });
  assert.throws(() => assertV1Spec(null), { message: 'The spec root must be a JSON object' });
  assert.throws(() => assertV1Spec({ mechanical: [] }), {
    message: 'spec.mechanical must be an object when present',
  });
  assert.throws(() => assertV1Spec({ semantic: 'one' }), {
    message: 'spec.semantic must be an array of strings when present',
  });
  assert.throws(() => assertV1Spec({ semantic: ['ok', 3] }), {
    message: 'spec.semantic must be an array of strings when present',
  });
});

test('absent blocks read as empty, and a size is itself a two-check spec', () => {
  assert.deepEqual(mechanicalBlock({}), {});
  assert.deepEqual(semanticAssertions({}), []);
  assert.deepEqual(specFromSize({ width: 512, height: 512 }), {
    mechanical: { width: 512, height: 512 },
  });
});

test('loadV1Spec parses and validates a file', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pixelproof-spec-'));
  try {
    const good = path.join(directory, 'good.json');
    const bad = path.join(directory, 'bad.json');
    await writeFile(good, JSON.stringify({ mechanical: { width: 4 } }));
    await writeFile(bad, JSON.stringify([1, 2]));
    assert.deepEqual(await loadV1Spec(good), { mechanical: { width: 4 } });
    await assert.rejects(loadV1Spec(bad), { message: 'The spec root must be a JSON object' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('prompt folding restates every declared requirement', () => {
  const prompt = foldSpecIntoPrompt(
    '  A ceramic desk lamp  ',
    {
      mechanical: {
        aspect: '1:1',
        corners: { expect: '#FFFFFF' },
        alpha: 'opaque',
        maxBytes: 4096,
      },
      semantic: ['No text of any kind'],
    },
    { width: 1254, height: 1254 },
  );

  assert.equal(prompt, [
    'A ceramic desk lamp',
    '',
    'Pixelproof spec constraints:',
    '- Output dimensions: exactly 1254x1254 pixels.',
    '- Aspect ratio: 1:1.',
    '- Background and all four corner pixels: #FFFFFF (the verifier allows ±3 per RGB channel).',
    '- The image must be fully opaque.',
    '- Keep the PNG at or below 4096 bytes.',
    '- Semantic requirements:',
    '  - No text of any kind',
  ].join('\n'));
});

test('prompt folding states the corner tolerance the verifier will actually use', () => {
  const prompt = foldSpecIntoPrompt('lamp', {
    mechanical: { corners: { expect: '#FFFFFF', tolerance: 10 } },
  }, { width: 8, height: 8 });
  assert.match(prompt, /allows ±10 per RGB channel/);
});

test('prompt folding adds only the dimensions for an empty spec', () => {
  assert.equal(
    foldSpecIntoPrompt('lamp', {}, { width: 8, height: 8 }),
    'lamp\n\nPixelproof spec constraints:\n- Output dimensions: exactly 8x8 pixels.',
  );
  assert.match(
    foldSpecIntoPrompt('lamp', { mechanical: { alpha: 'transparent' } }, { width: 8, height: 8 }),
    /genuine transparency/,
  );
});

test('runOnce passes the request through and reports success without verification', async () => {
  const seen = [];
  const result = await runOnce({
    generate: (request) => {
      seen.push(request);
      return { outputPath: '/tmp/out.png' };
    },
    request: { prompt: 'lamp' },
  });

  assert.deepEqual(seen, [{ prompt: 'lamp' }]);
  assert.deepEqual(result.generation, { outputPath: '/tmp/out.png' });
  assert.equal(result.verification, null);
  assert.equal(result.ok, true);
});

test('runOnce observes the artifact before verifying it', async () => {
  const order = [];
  const result = await runOnce({
    generate: () => {
      order.push('generate');
      return { outputPath: '/tmp/out.png' };
    },
    onGenerated: () => { order.push('observe'); },
    verify: () => {
      order.push('verify');
      return { ok: false };
    },
  });

  assert.deepEqual(order, ['generate', 'observe', 'verify']);
  assert.equal(result.ok, false);
});

test('runOnce reports an inapplicable verification as a pass, not a silent one', async () => {
  const result = await runOnce({
    generate: () => ({ outputPath: '/tmp/out.svg' }),
    verify: () => null,
  });
  assert.equal(result.verification, null);
  assert.equal(result.ok, true);
});

test('runOnce still reports the artifact when verification throws', async () => {
  const observed = [];
  await assert.rejects(runOnce({
    generate: () => ({ outputPath: '/tmp/out.png' }),
    onGenerated: (generation) => { observed.push(generation.outputPath); },
    verify: () => { throw new Error('missing file'); },
  }), { message: 'missing file' });
  assert.deepEqual(observed, ['/tmp/out.png']);
});

test('runOnce refuses to run without a generator', async () => {
  await assert.rejects(runOnce({ request: {} }), {
    name: 'TypeError',
    message: 'runOnce requires a generate function',
  });
});
