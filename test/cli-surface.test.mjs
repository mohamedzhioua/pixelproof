import assert from 'node:assert/strict';
import { Console } from 'node:console';
import test from 'node:test';
import { Writable } from 'node:stream';

import {
  GENERATE_USAGE,
  VERIFY_USAGE,
  parseGenerateArguments,
  parseVerifyArguments,
} from '../surfaces/cli/parse.mjs';
import {
  printGenerationError,
  printMissingOption,
  printUsage,
  printUsageError,
  printVerificationError,
  usageErrorText,
  verificationErrorResult,
} from '../surfaces/cli/format-errors.mjs';
import {
  displayValue,
  printVerificationJson,
  printVerificationResult,
  printWarning,
  verificationRows,
} from '../surfaces/cli/format-verification.mjs';

/**
 * These are unit tests for the CLI surface in isolation. They deliberately do
 * not re-assert the end-to-end frozen text — `verify-cli.compat.test.mjs` and
 * `generate-cli.compat.test.mjs` own that contract by spawning the real
 * commands. What is proven here is the part a spawned test cannot see cheaply:
 * which stream each line lands on, and the exact separation between them.
 */
function capture() {
  let stdout = '';
  let stderr = '';
  const sink = (append) => new Writable({
    write(chunk, _encoding, callback) {
      append(String(chunk));
      callback();
    },
  });
  const output = new Console({
    stdout: sink((value) => { stdout += value; }),
    stderr: sink((value) => { stderr += value; }),
    colorMode: false,
  });
  return { output, get stdout() { return stdout; }, get stderr() { return stderr; } };
}

const RESULT = {
  file: '/tmp/probe.png',
  spec: null,
  decoder: 'png-header-fallback',
  degraded: true,
  passed: 1,
  failed: 0,
  skipped: 1,
  strict: false,
  ok: true,
  checks: [
    { name: 'width', expected: 2, actual: 2, passed: true, status: 'PASS' },
    { name: 'corners', expected: '#FFFFFF', actual: 'sharp unavailable', passed: null, status: 'SKIP' },
  ],
  summary: { passed: 1, failed: 0, skipped: 1 },
  warnings: ['sharp is unavailable'],
  notes: ['a note'],
};

test('parses the verifier vocabulary, including the value-that-looks-like-a-flag rejection', () => {
  assert.deepEqual(
    parseVerifyArguments(['--file', 'a.png', '--spec', 's.json', '--json', '--strict']),
    { json: true, strict: true, help: false, file: 'a.png', spec: 's.json' },
  );
  assert.deepEqual(parseVerifyArguments([]), { json: false, strict: false, help: false });
  assert.deepEqual(parseVerifyArguments(['-h']).help, true);
  assert.deepEqual(parseVerifyArguments(['--help']).help, true);

  assert.throws(() => parseVerifyArguments(['--file']), { message: '--file requires a value' });
  assert.throws(
    () => parseVerifyArguments(['--file', '--json']),
    { message: '--file requires a value' },
  );
  assert.throws(() => parseVerifyArguments(['--nope']), { message: 'Unknown argument: --nope' });
  assert.throws(() => parseVerifyArguments(['stray']), { message: 'Unknown argument: stray' });
});

test('parses the generator vocabulary and camel-cases only its dashed option', () => {
  const options = parseGenerateArguments([
    '--prompt', 'a lamp',
    '--out', 'out.png',
    '--provider', 'svg',
    '--size', '16x16',
    '--spec', 's.json',
    '--svg-file', 'icon.svg',
  ]);
  assert.deepEqual(options, {
    help: false,
    prompt: 'a lamp',
    out: 'out.png',
    provider: 'svg',
    size: '16x16',
    spec: 's.json',
    svgFile: 'icon.svg',
  });

  assert.deepEqual(parseGenerateArguments([]), { help: false });
  assert.throws(() => parseGenerateArguments(['--out']), { message: '--out requires a value' });
  assert.throws(
    () => parseGenerateArguments(['--json']),
    { message: 'Unknown argument: --json' },
  );
});

test('keeps the usage banners identical between --help and a usage error', () => {
  const help = capture();
  printUsage(VERIFY_USAGE, help.output);
  assert.equal(help.stdout, `${VERIFY_USAGE}\n`);
  assert.equal(help.stderr, '');

  const failed = capture();
  printUsageError('Unknown argument: --nope', VERIFY_USAGE, failed.output);
  assert.equal(failed.stdout, '');
  assert.equal(failed.stderr, `Error: Unknown argument: --nope\n\n${VERIFY_USAGE}\n`);

  const missing = capture();
  printMissingOption('--out', GENERATE_USAGE, missing.output);
  assert.equal(missing.stdout, '');
  assert.equal(missing.stderr, `Error: --out is required\n\n${GENERATE_USAGE}\n`);

  assert.equal(usageErrorText('x', 'banner\n'), 'Error: x\n\nbanner\n');
});

test('routes run-time errors to stderr, and the --json failure document to stdout', () => {
  const human = capture();
  printVerificationError(new Error('bad spec'), { json: false, strict: false }, human.output);
  assert.equal(human.stdout, '');
  assert.equal(human.stderr, 'Verification error: bad spec\n');

  const json = capture();
  printVerificationError(new Error('bad spec'), { json: true, strict: true }, json.output);
  assert.equal(json.stderr, '');
  assert.deepEqual(JSON.parse(json.stdout), {
    passed: 0,
    failed: 1,
    skipped: 0,
    strict: true,
    ok: false,
    error: 'bad spec',
  });
  // Field order is part of the frozen document, not only the field set.
  assert.deepEqual(
    Object.keys(verificationErrorResult(new Error('e'))),
    ['passed', 'failed', 'skipped', 'strict', 'ok', 'error'],
  );

  const generation = capture();
  printGenerationError(new Error('no provider'), generation.output);
  assert.equal(generation.stdout, '');
  assert.equal(generation.stderr, 'Generation error: no provider\n');
});

test('prints the verification report to stdout and its warnings to stderr', () => {
  const printed = capture();
  printVerificationResult(RESULT, printed.output);

  const lines = printed.stdout.split('\n');
  assert.equal(lines[0], 'Mechanical verification: PASS (1 checks SKIPPED - not verified)');
  assert.equal(lines[1], 'File: /tmp/probe.png');
  assert.equal(lines[2], 'Decoder: png-header-fallback');
  assert.match(printed.stdout, /^Note: a note$/m);
  assert.match(printed.stdout, /^Summary: 1 passed, 0 failed, 1 skipped$/m);
  // The table is rendered by console.table; assert its cells, not its borders.
  assert.match(printed.stdout, /Check/);
  assert.match(printed.stdout, /width/);
  assert.match(printed.stdout, /SKIP/);

  assert.equal(printed.stderr, 'Warning: sharp is unavailable\n');
  assert.doesNotMatch(printed.stdout, /^Warning:/m);

  const failing = capture();
  printVerificationResult({ ...RESULT, ok: false, skipped: 0, checks: [], notes: [], warnings: [] }, failing.output);
  assert.equal(failing.stdout.split('\n')[0], 'Mechanical verification: FAIL');
  assert.equal(failing.stderr, '');
});

test('renders check values the way a spec author wrote them', () => {
  assert.equal(displayValue('1:1'), '1:1');
  assert.equal(displayValue(1254), '1254');
  assert.deepEqual(displayValue({ expect: '#FFF' }), '{"expect":"#FFF"}');

  assert.deepEqual(verificationRows(RESULT), [
    { Check: 'width', Expected: '2', Actual: '2', Result: 'PASS' },
    {
      Check: 'corners',
      Expected: '#FFFFFF',
      Actual: 'sharp unavailable',
      Result: 'SKIP',
    },
  ]);
});

test('emits the machine-readable result as two-space JSON on stdout', () => {
  const printed = capture();
  printVerificationJson(RESULT, printed.output);
  assert.equal(printed.stderr, '');
  assert.equal(printed.stdout, `${JSON.stringify(RESULT, null, 2)}\n`);
  assert.deepEqual(JSON.parse(printed.stdout), RESULT);
});

test('shares the Warning: convention between verification and generation', () => {
  const printed = capture();
  printWarning('a raster was not available', printed.output);
  assert.equal(printed.stdout, '');
  assert.equal(printed.stderr, 'Warning: a raster was not available\n');
});
