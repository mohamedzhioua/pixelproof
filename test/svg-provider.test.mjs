import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
// Imported through the v1 façade on purpose: the shim is part of the frozen
// surface, so exercising the whole suite through it keeps a broken re-export
// from passing unnoticed. The implementation itself now lives in
// `providers/svg.mjs`.
import { generateWithSvg, validateSvgXml } from '../scripts/providers/svg.mjs';
import {
  hasSharp,
  isolateModule,
  removeTemporaryDirectory,
  temporaryDirectory,
} from './helpers/compat-harness.mjs';

const VALID_SVG = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 8">
  <rect width="16" height="8" fill="#123456"/>
</svg>
`;

test('validates and writes SVG passthrough without changing its bytes', async () => {
  const root = await temporaryDirectory('pixelproof-svg-passthrough-');
  try {
    assert.deepEqual(validateSvgXml(VALID_SVG), { viewBox: '0 0 16 8' });
    const outputPath = path.join(root, 'nested', 'icon.svg');
    const result = await generateWithSvg({
      svgText: VALID_SVG,
      outPath: outputPath,
      width: 512,
      height: 256,
    });

    assert.equal(result.provider, 'svg');
    assert.equal(result.outputPath, outputPath);
    assert.equal(result.svgPath, outputPath);
    assert.equal(result.pngPath, null);
    assert.equal(result.viewBox, '0 0 16 8');
    assert.deepEqual(result.warnings, []);
    assert.equal(await readFile(outputPath, 'utf8'), VALID_SVG);
  } finally {
    await removeTemporaryDirectory(root);
  }
});

test('rejects malformed XML, non-SVG roots, and missing or invalid viewBox values', () => {
  const cases = [
    [
      '<svg viewBox="0 0 1 1"><g></svg>',
      /Closing tag <\/svg> does not match <g>/,
    ],
    [
      '<rect viewBox="0 0 1 1"/>',
      /SVG root element must be <svg>, not <rect>/,
    ],
    [
      '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
      /root <svg> element must declare a viewBox/,
    ],
    [
      '<svg viewBox="0 0 nope 1"/>',
      /viewBox must contain four finite numbers/,
    ],
    [
      '<svg viewBox="0 0 0 1"/>',
      /viewBox width and height must be greater than zero/,
    ],
    [
      '<!DOCTYPE svg><svg viewBox="0 0 1 1"/>',
      /DOCTYPE and other XML declarations are not allowed/,
    ],
  ];

  for (const [source, expected] of cases) {
    assert.throws(() => validateSvgXml(source), expected);
  }
});

test('rasterizes through sharp when present and asserts companion-SVG degradation when absent', async () => {
  const root = await temporaryDirectory('pixelproof-svg-raster-');
  try {
    const outputPath = path.join(root, 'normal', 'icon.png');
    const normal = await generateWithSvg({
      svgText: VALID_SVG,
      outPath: outputPath,
      width: 7,
      height: 5,
    });

    if (await hasSharp()) {
      assert.equal(normal.outputPath, outputPath);
      assert.equal(normal.pngPath, outputPath);
      assert.deepEqual(normal.warnings, []);
      assert.equal((await stat(outputPath)).isFile(), true);
      const { default: sharp } = await import('sharp');
      const metadata = await sharp(outputPath).metadata();
      assert.equal(metadata.width, 7);
      assert.equal(metadata.height, 5);
    } else {
      const companionPath = path.join(root, 'normal', 'icon.svg');
      assert.equal(normal.outputPath, companionPath);
      assert.equal(normal.svgPath, companionPath);
      assert.equal(normal.pngPath, null);
      assert.match(normal.warnings[0], /^sharp is unavailable/);
      assert.match(normal.warnings[0], /could not rasterise/);
      assert.equal(await readFile(companionPath, 'utf8'), VALID_SVG);
      await assert.rejects(stat(outputPath), { code: 'ENOENT' });
    }

    // The provider now lives under `providers/` and imports `core/`, so the
    // harness copies that layer alongside it rather than the file alone: a lone
    // copy would fail to resolve `../core/...` and the run would die for a
    // reason unrelated to `sharp`. Isolation still comes from the destination
    // having no `node_modules`, which is why `sharp` genuinely cannot load
    // there.
    const isolatedRoot = path.join(root, 'isolated');
    const isolatedProviderPath = await isolateModule(
      isolatedRoot,
      'providers/svg.mjs',
      ['core'],
    );
    const isolated = await import(`${pathToFileURL(isolatedProviderPath).href}?no-sharp`);
    const isolatedPng = path.join(root, 'isolated-output', 'icon.png');
    const degraded = await isolated.generateWithSvg({
      svgText: VALID_SVG,
      outPath: isolatedPng,
      width: 7,
      height: 5,
    });
    const isolatedSvg = path.join(root, 'isolated-output', 'icon.svg');
    assert.equal(degraded.outputPath, isolatedSvg);
    assert.equal(degraded.svgPath, isolatedSvg);
    assert.equal(degraded.pngPath, null);
    assert.match(degraded.warnings[0], /^sharp is unavailable/);
    assert.equal(await readFile(isolatedSvg, 'utf8'), VALID_SVG);
    await assert.rejects(stat(isolatedPng), { code: 'ENOENT' });
  } finally {
    await removeTemporaryDirectory(root);
  }
});

test('rejects unsupported output extensions before writing an asset', async () => {
  const root = await temporaryDirectory('pixelproof-svg-extension-');
  try {
    await assert.rejects(
      generateWithSvg({ svgText: VALID_SVG, outPath: path.join(root, 'icon.jpg') }),
      /SVG provider output must end in \.svg or \.png/,
    );
  } finally {
    await removeTemporaryDirectory(root);
  }
});
