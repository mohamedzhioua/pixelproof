import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  TRUST_BUILTIN,
  TRUST_EXTERNAL,
  createRegistry,
  discoverProviders,
  probeRegistry,
  selectProvider,
} from '../core/adapters/discover.mjs';
import { parseGenerateResponse, preflight, validateGenerateRequest } from '../core/contracts/provider.mjs';
import * as codex from '../providers/codex.mjs';
import * as svg from '../providers/svg.mjs';
import * as echo from './fixtures/providers/echo.mjs';
import { removeTemporaryDirectory, temporaryDirectory } from './helpers/compat-harness.mjs';

/** The composition layer's list, in the order it registers them. */
const BUILTINS = [codex, svg];

function externalStub(providerId) {
  return {
    manifest: { protocol: 1, id: providerId, kinds: ['raster'] },
    generate: async () => ({ protocol: 1, ok: true, file: '/tmp/x.png' }),
  };
}

test('the Codex capability record carries the geometry v1 hardcoded', () => {
  assert.deepEqual(codex.manifest.kinds, ['raster']);
  assert.equal(codex.manifest.capabilities.dimensionMultiple, 16);
  assert.equal(codex.manifest.capabilities.maxWidth, 3840);
  assert.equal(codex.manifest.capabilities.maxHeight, 3840);
  assert.equal(codex.manifest.capabilities.minPixels, 655360);
  assert.equal(codex.manifest.capabilities.maxPixels, 8294400);
  assert.equal(codex.manifest.capabilities.maxAspectRatio, 3);
  assert.equal(codex.manifest.capabilities.seed, false);
  assert.equal(codex.manifest.capabilities.references, false);
});

test('the generic preflight enforces Codex geometry whatever produced the dimensions', () => {
  const requestFor = (width, height) => validateGenerateRequest({
    protocol: 1,
    kind: 'raster',
    prompt: 'a ceramic desk lamp on seamless white',
    out: 'out/lamp.png',
    width,
    height,
  });

  // Whether these came from --size, a spec's mechanical block, or the 1024x1024
  // default is not something preflight can see, which is the point.
  assert.equal(preflight(codex.manifest, requestFor(1024, 1024)), true);
  assert.equal(preflight(codex.manifest, requestFor(1536, 1024)), true);

  for (const [width, height, pattern] of [
    [512, 512, /total pixels/iu],
    [1025, 1024, /multiples of 16/iu],
    [4096, 1600, /at most 3840/iu],
    [3072, 512, /ratio/iu],
  ]) {
    assert.throws(() => preflight(codex.manifest, requestFor(width, height)), pattern, `${width}x${height}`);
  }

  const vectorRequest = validateGenerateRequest({
    protocol: 1,
    kind: 'vector',
    prompt: 'a wordmark',
    out: 'out/lamp.svg',
  });
  assert.throws(() => preflight(codex.manifest, vectorRequest), /does not support kind/iu);
});

test('the frozen assertCodexSize wording is a rendering of the same capability record', () => {
  assert.doesNotThrow(() => codex.assertCodexSize({ width: 1024, height: 1024 }));

  const cases = [
    [{ width: 512, height: 512 }, /minimum total pixel count 655360/],
    [{ width: 1025, height: 1024 }, /width 1025 is not a multiple of 16/],
    [{ width: 4096, height: 1600 }, /width 4096 exceeds the maximum edge length 3840/],
    [{ width: 3072, height: 512 }, /exceeds the maximum 3:1 ratio/],
  ];

  for (const [size, pattern] of cases) {
    assert.throws(() => codex.assertCodexSize(size), pattern, JSON.stringify(size));
    assert.throws(() => codex.assertCodexSize(size), /cannot be honoured by gpt-image-2/);
  }
});

test('the SVG manifest declares both kinds and no invented pixel bounds', () => {
  assert.deepEqual(svg.manifest.kinds, ['vector', 'raster']);
  assert.equal(svg.manifest.capabilities.maxWidth, null);
  assert.equal(svg.manifest.capabilities.maxPixels, null);
  assert.equal(svg.manifest.capabilities.transparency, true);
  assert.deepEqual(svg.detect(), { available: true, reason: null });
});

test('the SVG adapter answers the contract and reports warnings instead of printing them', async () => {
  const root = await temporaryDirectory('pixelproof-svg-contract-');
  try {
    const outPath = path.join(root, 'icon.svg');
    const markup = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8"/></svg>';
    const response = parseGenerateResponse(
      await svg.generate({
        protocol: 1,
        kind: 'vector',
        prompt: 'a solid square',
        out: outPath,
        options: { svgText: markup },
      }),
      { expectedOut: outPath },
    );

    assert.equal(response.ok, true);
    assert.equal(response.provider, 'svg');
    assert.deepEqual(response.warnings, []);
    assert.equal(response.meta.viewBox, '0 0 8 8');
    assert.equal(await readFile(outPath, 'utf8'), markup);

    await assert.rejects(
      svg.generate({ protocol: 1, kind: 'vector', prompt: markup, out: path.join(root, 'icon.png') }),
      (error) => error.code === 'INVALID_REQUEST' && /cannot write kind "vector"/.test(error.message),
    );
    await assert.rejects(
      svg.generate({ protocol: 1, kind: 'vector', prompt: '<svg/>', out: path.join(root, 'broken.svg') }),
      (error) => error.code === 'INVALID_REQUEST' && /viewBox/.test(error.message),
    );
  } finally {
    await removeTemporaryDirectory(root);
  }
});

test('the Codex adapter refuses impossible or under-specified work before spawning anything', async () => {
  const request = (overrides) => ({
    protocol: 1,
    kind: 'raster',
    prompt: 'a ceramic desk lamp',
    out: 'out/lamp.png',
    ...overrides,
  });

  await assert.rejects(
    codex.generate(request({ width: 512, height: 512 })),
    (error) => error.code === 'INVALID_REQUEST' && /total pixels/i.test(error.message),
  );
  await assert.rejects(
    codex.generate(request({})),
    (error) => error.code === 'INVALID_REQUEST' && /requires both width and height/.test(error.message),
  );
  await assert.rejects(
    codex.generate(request({ kind: 'vector', out: 'out/lamp.svg', width: 1024, height: 1024 })),
    /does not support kind/iu,
  );
});

test('registration order is the discovery order, and external adapters sort by id', () => {
  const registry = discoverProviders({
    builtins: BUILTINS,
    external: [externalStub('zebra'), externalStub('alpaca')],
  });

  assert.deepEqual(registry.ids(), ['codex', 'svg', 'alpaca', 'zebra']);
  assert.equal(registry.get('codex').trust, TRUST_BUILTIN);
  assert.equal(registry.get('alpaca').trust, TRUST_EXTERNAL);
  assert.deepEqual(discoverProviders({ builtins: BUILTINS }).ids(), ['codex', 'svg']);
});

test('a duplicate id is fatal rather than last-one-wins', () => {
  assert.throws(
    () => discoverProviders({ builtins: BUILTINS, external: [externalStub('codex')] }),
    (error) => error.code === 'INVALID_REQUEST' && /Duplicate provider id "codex"/.test(error.message),
    'an external adapter must not be able to shadow a built-in',
  );

  assert.throws(() => createRegistry([echo, echo]), /Duplicate provider id "echo"/);
});

test('registration rejects a provider that cannot honour the contract', () => {
  assert.throws(() => createRegistry([{ manifest: echo.manifest }]), /must expose a generate function/);
  assert.throws(
    () => createRegistry([{ id: 'other', manifest: echo.manifest, generate: () => {} }]),
    /disagrees with its manifest id/,
  );
  assert.throws(
    () => createRegistry([{ manifest: { protocol: 1, id: 'bad', kinds: ['raster'], capabilities: { maxWidth: 0 } }, generate: () => {} }]),
    /positive integer/iu,
    'a malformed capability record must fail at registration, not at the first paid call',
  );
});

test('a new provider is registered and run without any edit under core/', async () => {
  const registry = discoverProviders({ builtins: [...BUILTINS, echo] });
  assert.deepEqual(registry.ids(), ['codex', 'svg', 'echo']);

  const root = await temporaryDirectory('pixelproof-echo-provider-');
  try {
    const entry = selectProvider(registry, { id: 'echo', kind: 'vector' });
    const outPath = path.join(root, 'echo', 'out.svg');
    const response = parseGenerateResponse(
      await entry.generate({
        protocol: 1,
        kind: 'vector',
        prompt: 'hello from a fixture provider',
        out: outPath,
        width: 16,
        height: 16,
        seed: 7,
      }),
      { expectedOut: outPath },
    );

    assert.equal(response.ok, true);
    assert.equal(response.provider, 'echo');
    assert.equal(response.seed, 7);
    assert.equal(await readFile(outPath, 'utf8'), 'hello from a fixture provider');

    // The fixture's own declared bounds are enforced by the same generic
    // preflight the built-ins use.
    await assert.rejects(
      entry.generate({ protocol: 1, kind: 'vector', prompt: 'too big', out: outPath, width: 128, height: 16 }),
      /at most 64/iu,
    );
  } finally {
    await removeTemporaryDirectory(root);
  }
});

test('selectProvider distinguishes an unknown provider from an unsupported kind', () => {
  const registry = discoverProviders({ builtins: BUILTINS });

  assert.throws(
    () => selectProvider(registry, { id: 'nope' }),
    (error) => error.code === 'PROVIDER_UNAVAILABLE',
  );
  assert.throws(
    () => selectProvider(registry, { id: 'codex', kind: 'vector' }),
    (error) => error.code === 'INVALID_REQUEST' && /does not support kind "vector"/.test(error.message),
  );
  assert.equal(selectProvider(registry, { id: 'svg', kind: 'raster' }).id, 'svg');
});

test('probing reports availability in registry order and survives a broken detect', async () => {
  const broken = {
    manifest: { protocol: 1, id: 'broken', kinds: ['raster'] },
    detect: () => {
      throw new Error('probe blew up');
    },
    generate: async () => ({ protocol: 1, ok: true, file: '/tmp/x.png' }),
  };

  const probes = await probeRegistry(discoverProviders({ builtins: [svg, echo, broken] }));

  assert.deepEqual(probes.map((probe) => probe.id), ['svg', 'echo', 'broken']);
  assert.equal(probes[0].available, true);
  assert.equal(probes[1].available, true);
  assert.equal(probes[2].available, false);
  assert.equal(probes[2].reason, 'probe blew up');
  assert.equal(probes[0].trust, TRUST_BUILTIN);
});
