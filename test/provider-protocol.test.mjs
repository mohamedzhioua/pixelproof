import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ADAPTER_ERROR_CODES,
  AdapterError,
  exitCodeForError,
  isAdapterErrorCode,
  normalizeErrorPayload,
} from '../core/contracts/errors.mjs';
import {
  MAX_RESPONSE_BYTES,
  PROTOCOL_VERSION,
  parseGenerateResponse,
  preflight,
  validateGenerateRequest,
  validateManifest,
} from '../core/contracts/provider.mjs';

/**
 * Deliberately neutral ids. `core/contracts/` must never learn a vendor name,
 * and a test that reached for one would be the first place the rule eroded.
 */
const MANIFEST = Object.freeze({
  protocol: 1,
  id: 'demo-raster',
  kinds: ['raster'],
  capabilities: {
    minWidth: 256,
    maxWidth: 3840,
    minHeight: 256,
    maxHeight: 3840,
    dimensionMultiple: 16,
    minPixels: 655360,
    maxPixels: 8294400,
    maxAspectRatio: 3,
    seed: true,
  },
});

function request(overrides = {}) {
  return {
    protocol: 1,
    kind: 'raster',
    prompt: 'a ceramic desk lamp on seamless white',
    out: '/abs/out/lamp.png',
    width: 1024,
    height: 1024,
    ...overrides,
  };
}

test('accepts a well-formed manifest and fills unconstrained bounds with null', () => {
  const manifest = validateManifest({ protocol: 1, id: 'minimal', kinds: ['vector'] });

  assert.equal(manifest.id, 'minimal');
  assert.deepEqual(manifest.kinds, ['vector']);
  assert.equal(manifest.capabilities.maxWidth, null, 'an absent bound means unconstrained');
  assert.equal(manifest.capabilities.seed, false, 'optional capabilities default to unsupported');
});

test('rejects malformed manifests', () => {
  const cases = [
    [{ protocol: 2, id: 'demo', kinds: ['raster'] }, /protocol/iu],
    [{ protocol: 1, id: 'Demo_Provider', kinds: ['raster'] }, /kebab-case/iu],
    [{ protocol: 1, id: 'demo', kinds: [] }, /at least one kind/iu],
    [{ protocol: 1, id: 'demo', kinds: ['audio'] }, /at least one kind/iu],
    [{ protocol: 1, id: 'demo', kinds: ['raster'], capabilities: { minWidth: 0 } }, /positive integer/iu],
    [
      { protocol: 1, id: 'demo', kinds: ['raster'], capabilities: { minWidth: 900, maxWidth: 100 } },
      /minWidth greater than maxWidth/iu,
    ],
    ['not-an-object', /JSON object/iu],
  ];

  for (const [value, pattern] of cases) {
    assert.throws(() => validateManifest(value), pattern, `expected rejection for ${JSON.stringify(value)}`);
  }
});

test('ignores unknown manifest fields so a newer adapter still interoperates', () => {
  const manifest = validateManifest({
    protocol: 1,
    id: 'demo',
    kinds: ['raster'],
    capabilities: { seed: true, somethingAddedLater: 'ignored' },
    futureField: { nested: true },
  });

  assert.equal(manifest.capabilities.seed, true);
  assert.equal(manifest.futureField, undefined, 'unknown fields are dropped, not carried through');
});

test('normalizes a generate request and defaults its optional fields', () => {
  const normalized = validateGenerateRequest(request());

  assert.equal(normalized.protocol, PROTOCOL_VERSION);
  assert.equal(normalized.attempt, 1);
  assert.equal(normalized.negative, null);
  assert.equal(normalized.seed, null);
  assert.deepEqual(normalized.references, []);
  assert.deepEqual(normalized.priorFailures, []);
  assert.deepEqual(normalized.options, {});
});

test('rejects malformed generate requests', () => {
  const cases = [
    [request({ prompt: '   ' }), /prompt/iu],
    [request({ out: '' }), /out/iu],
    [request({ kind: 'audio' }), /kind/iu],
    [request({ width: 0 }), /positive integer/iu],
    [request({ width: 1024.5 }), /positive integer/iu],
    [request({ references: [42] }), /array of strings/iu],
    [request({ protocol: 99 }), /protocol/iu],
  ];

  for (const [value, pattern] of cases) {
    assert.throws(() => validateGenerateRequest(value), pattern);
  }
});

test('preflight rejects impossible work before a generation is paid for', () => {
  const manifest = validateManifest(MANIFEST);

  const violations = [
    [{ width: 100, height: 100 }, /at least 256/iu, 'below the minimum edge'],
    [{ width: 4096, height: 1024 }, /at most 3840/iu, 'above the maximum edge'],
    [{ width: 1000, height: 1024 }, /multiples of 16/iu, 'not on the dimension multiple'],
    [{ width: 3840, height: 256 }, /ratio/iu, 'beyond the aspect limit'],
    [{ width: 256, height: 256 }, /total pixels/iu, 'below the pixel floor'],
    [{ kind: 'vector' }, /does not support kind/iu, 'unsupported kind'],
  ];

  for (const [overrides, pattern, why] of violations) {
    assert.throws(
      () => preflight(manifest, validateGenerateRequest(request(overrides))),
      pattern,
      `expected preflight to reject ${why}`,
    );
  }

  assert.equal(preflight(manifest, validateGenerateRequest(request())), true);
});

test('preflight rejects features the manifest does not declare', () => {
  const manifest = validateManifest({ protocol: 1, id: 'plain', kinds: ['raster'] });

  assert.throws(
    () => preflight(manifest, validateGenerateRequest(request({ seed: 812345 }))),
    /does not support a fixed seed/iu,
  );
  assert.throws(
    () => preflight(manifest, validateGenerateRequest(request({ references: ['/abs/ref.png'] }))),
    /does not support reference images/iu,
  );
  assert.throws(
    () => preflight(manifest, validateGenerateRequest(request({ negative: 'text, hands' }))),
    /does not support a negative prompt/iu,
  );
});

test('preflight skips dimension rules when no dimensions were requested', () => {
  const manifest = validateManifest(MANIFEST);
  const normalized = validateGenerateRequest({
    protocol: 1,
    kind: 'raster',
    prompt: 'anything',
    out: '/abs/out/a.png',
  });

  assert.equal(preflight(manifest, normalized), true);
});

test('parses a successful response and rejects one that wrote elsewhere', () => {
  const parsed = parseGenerateResponse(
    {
      protocol: 1,
      ok: true,
      file: '/abs/out/lamp.png',
      provider: 'demo-raster',
      durationMs: 41200,
      addedInALaterRevision: true,
    },
    { expectedOut: '/abs/out/lamp.png' },
  );

  assert.equal(parsed.ok, true);
  assert.equal(parsed.provider, 'demo-raster');
  assert.deepEqual(parsed.warnings, []);

  assert.throws(
    () => parseGenerateResponse(
      { protocol: 1, ok: true, file: '/somewhere/else.png' },
      { expectedOut: '/abs/out/lamp.png' },
    ),
    /different path than requested/iu,
    'writing another path does not satisfy the request, however successful the adapter claims to be',
  );
});

test('rejects responses that are not shaped like either outcome', () => {
  assert.throws(() => parseGenerateResponse({ protocol: 1 }), /ok must be a boolean/iu);
  assert.throws(() => parseGenerateResponse({ protocol: 1, ok: true }), /name the file/iu);
  assert.throws(() => parseGenerateResponse({ protocol: 2, ok: true, file: '/a.png' }), /protocol/iu);
});

test('the error taxonomy is closed and maps to distinct exit codes', () => {
  assert.equal(ADAPTER_ERROR_CODES.length, 7);
  assert.ok(Object.isFrozen(ADAPTER_ERROR_CODES));
  assert.ok(!isAdapterErrorCode('SOMETHING_ELSE'));

  const exits = ADAPTER_ERROR_CODES.map((code) => exitCodeForError(code));
  assert.equal(new Set(exits).size, exits.length, 'each code gets its own exit status');
  assert.ok(!exits.includes(0) && !exits.includes(1), '0 and 1 keep their v1 meanings');
});

test('an unrecognised error code is narrowed to INTERNAL without losing what was reported', () => {
  const normalized = normalizeErrorPayload({ code: 'KABOOM', message: 'went wrong' });

  assert.equal(normalized.code, 'INTERNAL');
  assert.equal(normalized.message, 'went wrong');
  assert.deepEqual(normalized.details, { reportedCode: 'KABOOM' });

  assert.equal(normalizeErrorPayload(null).code, 'INTERNAL');
  assert.equal(normalizeErrorPayload({ code: 'TIMEOUT' }).retryable, true);
  assert.equal(normalizeErrorPayload({ code: 'AUTH_REQUIRED' }).retryable, false);
});

test('AdapterError carries a protocol-shaped payload', () => {
  const payload = new AdapterError('RATE_LIMITED', 'slow down').toPayload();

  assert.deepEqual(payload, {
    protocol: 1,
    ok: false,
    error: { code: 'RATE_LIMITED', message: 'slow down', retryable: true },
  });
  assert.equal(new AdapterError('NOT_A_CODE', 'x').code, 'INTERNAL');
});

test('response size ceiling is a control-message bound, not an image bound', () => {
  assert.ok(MAX_RESPONSE_BYTES <= 1024 * 1024);
});
