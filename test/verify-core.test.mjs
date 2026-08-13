import assert from 'node:assert/strict';
import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { verifyImage } from '../scripts/verify.mjs';
import {
  hasSharp,
  removeTemporaryDirectory,
  temporaryDirectory,
  verifierPath,
  writePng,
} from './helpers/compat-harness.mjs';

function byName(result, name) {
  return result.checks.find((check) => check.name === name);
}

test('characterizes width, height, and the absolute aspect tolerance', async () => {
  const root = await temporaryDirectory('pixelproof-core-dimensions-');
  try {
    const withinTolerance = path.join(root, 'within.png');
    const outsideTolerance = path.join(root, 'outside.png');
    await Promise.all([
      writePng(withinTolerance, 100, 101),
      writePng(outsideTolerance, 100, 102),
    ]);

    const passing = await verifyImage({
      filePath: withinTolerance,
      spec: { mechanical: { width: 100, height: 101, aspect: '1:1' } },
    });
    assert.deepEqual(
      passing.checks.map(({ name, status }) => ({ name, status })),
      [
        { name: 'width', status: 'PASS' },
        { name: 'height', status: 'PASS' },
        { name: 'aspect', status: 'PASS' },
      ],
    );
    assert.deepEqual(passing.summary, { passed: 3, failed: 0, skipped: 0 });
    assert.equal(passing.ok, true);

    const failing = await verifyImage({
      filePath: outsideTolerance,
      spec: { mechanical: { width: 99, height: 101, aspect: '1:1' } },
    });
    assert.deepEqual(
      failing.checks.map(({ name, status }) => ({ name, status })),
      [
        { name: 'width', status: 'FAIL' },
        { name: 'height', status: 'FAIL' },
        { name: 'aspect', status: 'FAIL' },
      ],
    );
    assert.deepEqual(failing.summary, { passed: 0, failed: 3, skipped: 0 });
    assert.equal(failing.ok, false);
  } finally {
    await removeTemporaryDirectory(root);
  }
});

test('characterizes corner tolerance with sharp and explicit SKIP without it', async () => {
  const root = await temporaryDirectory('pixelproof-core-corners-');
  try {
    const imagePath = path.join(root, 'corners.png');
    await writePng(imagePath, 2, 2, {
      pixel(x, y) {
        if (x === 0 && y === 0) return [255, 255, 255, 255];
        if (x === 1 && y === 0) return [254, 255, 255, 255];
        if (x === 0 && y === 1) return [255, 253, 255, 255];
        return [252, 252, 252, 255];
      },
    });

    const tolerant = await verifyImage({
      filePath: imagePath,
      spec: { mechanical: { corners: { expect: '#ffffff', tolerance: 3 } } },
    });
    const strictColor = await verifyImage({
      filePath: imagePath,
      spec: { mechanical: { corners: { expect: '#FFFFFF', tolerance: 2 } } },
    });

    if (await hasSharp()) {
      assert.equal(tolerant.decoder, 'sharp');
      assert.equal(byName(tolerant, 'corners').status, 'PASS');
      assert.match(byName(tolerant, 'corners').actual, /\(0,0\) #FFFFFF/);
      assert.equal(byName(strictColor, 'corners').status, 'FAIL');
    } else {
      assert.equal(tolerant.decoder, 'png-header-fallback');
      assert.equal(byName(tolerant, 'corners').status, 'SKIP');
      assert.equal(byName(tolerant, 'corners').actual, 'sharp unavailable');
      assert.equal(byName(strictColor, 'corners').status, 'SKIP');
    }
  } finally {
    await removeTemporaryDirectory(root);
  }
});

test('characterizes opaque, transparent, and any alpha modes with both capability paths', async () => {
  const root = await temporaryDirectory('pixelproof-core-alpha-');
  try {
    const opaquePath = path.join(root, 'opaque.png');
    const transparentPath = path.join(root, 'transparent.png');
    await Promise.all([
      writePng(opaquePath, 2, 2),
      writePng(transparentPath, 2, 2, {
        pixel: (x, y) => [255, 255, 255, x === 0 && y === 0 ? 0 : 255],
      }),
    ]);

    const opaque = await verifyImage({
      filePath: opaquePath,
      spec: { mechanical: { alpha: 'opaque' } },
    });
    const transparent = await verifyImage({
      filePath: transparentPath,
      spec: { mechanical: { alpha: 'transparent' } },
    });
    const transparentAsOpaque = await verifyImage({
      filePath: transparentPath,
      spec: { mechanical: { alpha: 'opaque' } },
    });
    const any = await verifyImage({
      filePath: transparentPath,
      spec: { mechanical: { alpha: 'any' } },
    });

    assert.equal(byName(any, 'alpha').status, 'PASS');
    assert.equal(byName(any, 'alpha').actual, 'any alpha accepted');
    if (await hasSharp()) {
      assert.equal(byName(opaque, 'alpha').status, 'PASS');
      assert.equal(byName(opaque, 'alpha').actual, 'range 255-255');
      assert.equal(byName(transparent, 'alpha').status, 'PASS');
      assert.equal(byName(transparent, 'alpha').actual, 'range 0-255');
      assert.equal(byName(transparentAsOpaque, 'alpha').status, 'FAIL');
    } else {
      assert.equal(byName(opaque, 'alpha').status, 'SKIP');
      assert.equal(byName(transparent, 'alpha').status, 'SKIP');
      assert.equal(byName(transparentAsOpaque, 'alpha').status, 'SKIP');
    }
  } finally {
    await removeTemporaryDirectory(root);
  }
});

test('characterizes maxBytes at its inclusive boundary', async () => {
  const root = await temporaryDirectory('pixelproof-core-bytes-');
  try {
    const imagePath = path.join(root, 'probe.png');
    await writePng(imagePath, 3, 3);
    const bytes = (await stat(imagePath)).size;

    const passing = await verifyImage({
      filePath: imagePath,
      spec: { mechanical: { maxBytes: bytes } },
    });
    const failing = await verifyImage({
      filePath: imagePath,
      spec: { mechanical: { maxBytes: bytes - 1 } },
    });
    assert.equal(byName(passing, 'maxBytes').actual, bytes);
    assert.equal(byName(passing, 'maxBytes').status, 'PASS');
    assert.equal(byName(failing, 'maxBytes').status, 'FAIL');
  } finally {
    await removeTemporaryDirectory(root);
  }
});

test('rejects malformed PNG data and invalid mechanical check values', async () => {
  const root = await temporaryDirectory('pixelproof-core-errors-');
  try {
    const malformed = path.join(root, 'malformed.png');
    const imagePath = path.join(root, 'probe.png');
    await Promise.all([
      writeFile(malformed, 'not a png'),
      writePng(imagePath, 1, 1),
    ]);

    await assert.rejects(
      verifyImage({ filePath: malformed, spec: { mechanical: { width: 1 } } }),
      /png|image|input|unsupported|header/i,
    );
    await assert.rejects(
      verifyImage({ filePath: imagePath, spec: { mechanical: { aspect: 'wide' } } }),
      /mechanical\.aspect must use the form width:height/,
    );
    await assert.rejects(
      verifyImage({ filePath: imagePath, spec: { mechanical: { corners: { expect: 'white' } } } }),
      /mechanical\.corners\.expect must be a colour in #RRGGBB form/,
    );
    await assert.rejects(
      verifyImage({ filePath: imagePath, spec: { mechanical: { alpha: 'partial' } } }),
      /mechanical\.alpha must be "opaque", "transparent", or "any"/,
    );
  } finally {
    await removeTemporaryDirectory(root);
  }
});

test('isolates decoder discovery to prove no-sharp skips and strict failure', async () => {
  const root = await temporaryDirectory('pixelproof-core-no-sharp-');
  try {
    const isolatedDirectory = path.join(root, 'isolated');
    const isolatedVerifier = path.join(isolatedDirectory, 'verify.mjs');
    const imagePath = path.join(root, 'probe.png');
    await mkdir(isolatedDirectory);
    await Promise.all([
      copyFile(verifierPath, isolatedVerifier),
      writePng(imagePath, 2, 2),
    ]);
    const isolated = await import(`${pathToFileURL(isolatedVerifier).href}?no-sharp`);
    const result = await isolated.verifyImage({
      filePath: imagePath,
      strict: true,
      spec: {
        mechanical: {
          width: 2,
          height: 2,
          corners: { expect: '#FFFFFF' },
          alpha: 'opaque',
        },
      },
    });

    assert.equal(result.decoder, 'png-header-fallback');
    assert.equal(result.degraded, true);
    assert.deepEqual(result.summary, { passed: 2, failed: 0, skipped: 2 });
    assert.deepEqual(
      result.checks.map(({ name, status }) => ({ name, status })),
      [
        { name: 'width', status: 'PASS' },
        { name: 'height', status: 'PASS' },
        { name: 'corners', status: 'SKIP' },
        { name: 'alpha', status: 'SKIP' },
      ],
    );
    assert.equal(result.ok, false);
    assert.match(result.warnings[0], /^sharp is unavailable/);
  } finally {
    await removeTemporaryDirectory(root);
  }
});
