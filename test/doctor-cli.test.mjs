import assert from 'node:assert/strict';
import { Console } from 'node:console';
import test from 'node:test';
import { Writable } from 'node:stream';

import {
  AUTH_AVAILABLE,
  AUTH_UNAVAILABLE,
  AUTH_UNKNOWN,
  CHECKS_REQUIRING_DECODER,
  DOCTOR_USAGE,
  describeCapabilities,
  doctorCommand,
} from '../surfaces/cli/commands/doctor.mjs';

/**
 * The doctor matrix.
 *
 * Every probe is faked through the `probes` seam, so nothing in this file
 * depends on whether a vendor CLI is installed, whether `sharp` resolved, or
 * whether anyone is logged in — the same matrix runs identically on a developer
 * laptop with Codex installed and on a CI lane installed with
 * `--omit=optional`. No test here spawns a process or opens a socket.
 *
 * Assertions target the *remediation text* as well as the status, because a
 * status without a fix is the report we already had.
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

const CODEX_MANIFEST = {
  id: 'codex',
  kinds: ['raster'],
  capabilities: {
    maxWidth: 3840,
    maxHeight: 3840,
    dimensionMultiple: 16,
    minPixels: 655_360,
    maxPixels: 8_294_400,
    maxAspectRatio: 3,
    seed: false,
    references: false,
    transparency: false,
    negativePrompt: false,
  },
};

const SVG_MANIFEST = {
  id: 'svg',
  kinds: ['vector', 'raster'],
  capabilities: {
    transparency: true,
    seed: false,
    references: false,
    negativePrompt: false,
  },
};

const codexRow = (available, reason = null) => ({
  id: 'codex',
  trust: 'builtin',
  kinds: ['raster'],
  available,
  reason,
  manifest: CODEX_MANIFEST,
});

const svgRow = (available, reason = null) => ({
  id: 'svg',
  trust: 'builtin',
  kinds: ['vector', 'raster'],
  available,
  reason,
  manifest: SVG_MANIFEST,
});

/** A decoder probe in either state, shaped exactly like `loadSharpDecoder`. */
const sharpPresent = () => ({ sharp: () => {}, error: null });
const sharpAbsent = () => ({ sharp: null, error: { code: 'ERR_MODULE_NOT_FOUND' } });

async function run({ argv = [], providers = [], decoder = sharpAbsent, auth = undefined }) {
  const printed = capture();
  const code = await doctorCommand({
    argv,
    probes: {
      output: printed.output,
      providers: async () => providers,
      decoder: async () => decoder(),
      ...(auth ? { auth } : {}),
    },
  });
  return { code, stdout: printed.stdout, stderr: printed.stderr };
}

test('no providers: reports an unusable environment and how to install one', async () => {
  const result = await run({ providers: [] });

  assert.equal(result.code, 1, 'nothing can run, so the exit code must be non-zero');
  assert.match(result.stdout, /^Providers \(0 of 0 available\)$/m);
  assert.match(result.stdout, /No providers are registered/);
  assert.match(result.stdout, /npm install -g @openai\/codex/);
  assert.match(result.stdout, /verdict: {6}unusable/);
  assert.match(result.stdout, /none available; pixelproof generate cannot run/);
});

test('every registered provider unavailable is still exit 1, with a per-provider fix', async () => {
  const result = await run({
    providers: [codexRow(false, 'codex was not found on PATH'), svgRow(false, 'module failed to load')],
  });

  assert.equal(result.code, 1);
  assert.match(result.stdout, /^ {2}codex \[unavailable\]$/m);
  assert.match(result.stdout, /reason: {7}codex was not found on PATH/);
  assert.match(result.stdout, /Install the Codex CLI: npm install -g @openai\/codex/);
  assert.match(result.stdout, /Sign in once \(interactive, not run by doctor\): codex login/);
  assert.match(result.stdout, /The svg provider needs nothing installed/);
  // An unavailable provider's authentication is never asserted either way.
  assert.match(result.stdout, /unknown \/ not safely probeable - not checked while the provider itself is unavailable/);
});

test('codex only: usable, capabilities readable, authentication reported as unknown', async () => {
  const result = await run({
    providers: [codexRow(true), svgRow(false, 'module failed to load')],
    decoder: sharpPresent,
  });

  assert.equal(result.code, 0, 'one available provider makes the environment usable');
  assert.match(result.stdout, /^ {2}codex \[available\]$/m);
  assert.match(
    result.stdout,
    /auth: {9}unknown \/ not safely probeable - the CLI is present, but its login\/subscription state cannot be checked without a network or paid call/,
  );
  assert.match(result.stdout, /note: {9}If generation fails with an authentication error, run: codex login/);
  assert.match(result.stdout, /width up to 3840px; height up to 3840px; edges a multiple of 16/);
  assert.match(result.stdout, /total pixels 655360-8294400; aspect ratio at most 3:1/);
  assert.match(result.stdout, /transparency: no; seed: no; references: no; negative prompt: no/);
  assert.match(result.stdout, /providers: {4}1 available \(codex\)/);
  // Scoped to the codex block: an available provider has nothing to remediate,
  // while the unavailable svg block below it still carries its own fix line.
  const codexBlock = result.stdout.split('\n\n').find((block) => block.includes('codex [available]'));
  assert.doesNotMatch(codexBlock, /fix:/, 'an available provider gets no fix line');
});

test('svg only: usable without any vendor CLI, and svg needs no credentials', async () => {
  const result = await run({
    providers: [codexRow(false, 'codex was not found on PATH'), svgRow(true)],
  });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /^ {2}svg \[available\]$/m);
  assert.match(result.stdout, /auth: {9}available - no credentials are required/);
  assert.match(result.stdout, /kinds: {8}vector, raster/);
  assert.match(result.stdout, /no declared size limits; transparency: yes/);
  assert.match(result.stdout, /providers: {4}1 available \(svg\)/);
  // Codex still gets its remediation even though the run is usable.
  assert.match(result.stdout, /npm install -g @openai\/codex/);
});

test('sharp absent: exit 0, but corners and alpha are named as SKIP with the install command', async () => {
  const result = await run({ providers: [svgRow(true)], decoder: sharpAbsent });

  assert.equal(result.code, 0, 'a missing decoder is degraded-but-usable, not a failure');
  assert.match(result.stdout, /sharp: {8}not installed \(ERR_MODULE_NOT_FOUND\)/);
  assert.match(result.stdout, /checks run: {3}width, height, aspect, maxBytes/);
  assert.match(
    result.stdout,
    /checks SKIP: {2}corners, alpha \(alpha still runs when a spec asks for "any"\)/,
  );
  assert.match(result.stdout, /fix: {10}npm install --include=optional sharp/);
  assert.match(result.stdout, /reinstall: npm ci --include=optional/);
  assert.match(result.stdout, /mechanical: {3}degraded - corners and alpha will report SKIP, not PASS/);
  assert.match(result.stdout, /verdict: {6}usable \(degraded\)/);
  assert.deepEqual([...CHECKS_REQUIRING_DECODER], ['corners', 'alpha']);
});

test('sharp present: every mechanical check is listed as runnable and nothing skips', async () => {
  const result = await run({ providers: [codexRow(true)], decoder: sharpPresent });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /sharp: {8}installed/);
  assert.match(result.stdout, /checks run: {3}width, height, aspect, maxBytes, corners, alpha/);
  assert.match(result.stdout, /checks SKIP: {2}none/);
  assert.match(result.stdout, /mechanical: {3}full - every mechanical check can run/);
  assert.match(result.stdout, /verdict: {6}usable$/m);
  assert.doesNotMatch(result.stdout, /include=optional/, 'no decoder fix when the decoder is there');
});

test('the three authentication states are distinct, and an unusable answer degrades to unknown', async () => {
  const rows = [
    { id: 'alpha-cli', trust: 'external', kinds: ['raster'], available: true },
    { id: 'beta-cli', trust: 'external', kinds: ['raster'], available: true },
    { id: 'gamma-cli', trust: 'external', kinds: ['raster'], available: true },
    { id: 'delta-cli', trust: 'external', kinds: ['raster'], available: true },
  ];
  const answers = {
    'alpha-cli': { state: AUTH_AVAILABLE, detail: 'a key file is present' },
    'beta-cli': { state: AUTH_UNAVAILABLE, detail: 'no credentials were found' },
    'gamma-cli': { state: AUTH_UNKNOWN, detail: 'proving it would cost a paid call' },
    'delta-cli': { state: 'ready' },
  };

  const result = await run({ providers: rows, auth: (row) => answers[row.id] });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /auth: {9}available - a key file is present/);
  assert.match(result.stdout, /auth: {9}unavailable - no credentials were found/);
  assert.match(result.stdout, /auth: {9}unknown \/ not safely probeable - proving it would cost a paid call/);
  // "ready" is not one of the three states, so it is not believed.
  assert.match(
    result.stdout,
    /auth: {9}unknown \/ not safely probeable - the authentication probe did not report a recognised state/,
  );
  assert.doesNotMatch(result.stdout, /auth: {9}ready/);
});

test('an unrecognised provider gets an honest unknown auth state and a generic fix', async () => {
  const result = await run({
    providers: [{ id: 'mystery', trust: 'external', kinds: ['raster'], available: true }],
  });

  assert.equal(result.code, 0);
  assert.match(
    result.stdout,
    /unknown \/ not safely probeable - this adapter declares no authentication model that can be checked safely/,
  );
  assert.match(result.stdout, /capabilities: {1}not declared/);

  const unavailable = await run({
    providers: [{ id: 'mystery', trust: 'external', kinds: [], available: false, reason: 'not on PATH' }],
  });
  assert.equal(unavailable.code, 1);
  assert.match(
    unavailable.stdout,
    /Install the executable that adapter "mystery" names and make sure it is on PATH/,
  );
  assert.match(unavailable.stdout, /kinds: {8}none declared/);
});

test('a probe that never settles is bounded by --timeout instead of hanging', async () => {
  const printed = capture();
  const started = Date.now();
  const code = await doctorCommand({
    argv: ['--timeout', '50'],
    probes: {
      output: printed.output,
      providers: () => new Promise(() => {}),
      decoder: () => new Promise(() => {}),
    },
  });

  assert.equal(code, 1, 'a report with no proven provider cannot claim the environment works');
  assert.ok(Date.now() - started < 5_000, 'the command must return within its own budget');
  assert.match(printed.stdout, /error: {8}provider detection timed out after 50ms/);
  assert.match(printed.stdout, /sharp: {8}not installed \(the sharp decoder probe timed out after 50ms\)/);
  assert.match(printed.stdout, /probe budget 50ms/);
});

test('a throwing probe becomes a reported line, not a crash', async () => {
  const providerFailure = await run({
    providers: [],
    decoder: sharpPresent,
  });
  assert.equal(providerFailure.code, 1);

  const printed = capture();
  const code = await doctorCommand({
    probes: {
      output: printed.output,
      providers: async () => { throw new Error('registry exploded'); },
      decoder: async () => { throw new Error('import exploded'); },
    },
  });
  assert.equal(code, 1);
  assert.match(printed.stdout, /error: {8}registry exploded/);
  assert.match(printed.stdout, /not installed \(import exploded\)/);
});

test('an authentication probe that hangs does not claim the provider is authenticated', async () => {
  const printed = capture();
  const code = await doctorCommand({
    argv: ['--timeout', '50'],
    probes: {
      output: printed.output,
      providers: async () => [codexRow(true)],
      decoder: sharpPresent,
      auth: () => new Promise(() => {}),
    },
  });

  assert.equal(code, 0, 'the provider is available even though its auth state is unknown');
  assert.match(
    printed.stdout,
    /auth: {9}unknown \/ not safely probeable - authentication probe for "codex" timed out after 50ms/,
  );
});

test('--json emits the same findings as a parseable document', async () => {
  const printed = capture();
  const code = await doctorCommand({
    argv: ['--json'],
    probes: {
      output: printed.output,
      providers: async () => [codexRow(true), svgRow(false, 'module failed to load')],
      decoder: sharpAbsent,
    },
  });

  assert.equal(code, 0);
  assert.equal(printed.stderr, '');
  const report = JSON.parse(printed.stdout);

  assert.equal(report.ok, true);
  assert.deepEqual(report.summary.availableIds, ['codex']);
  assert.equal(report.summary.providersTotal, 2);
  assert.equal(report.summary.degraded, true);
  assert.equal(report.summary.verdict, 'usable (degraded)');
  assert.equal(report.providers[0].auth.state, AUTH_UNKNOWN);
  assert.deepEqual(report.decoder.checksSkipped, ['corners', 'alpha']);
  assert.deepEqual(report.decoder.remediation, [
    'npm install --include=optional sharp',
    'If this tree was installed with --omit=optional, reinstall: npm ci --include=optional',
  ]);
  assert.deepEqual(report.providers[1].remediation, [
    'The svg provider needs nothing installed, so a failure here means the module '
      + 'did not load; reinstall the tree: npm ci',
  ]);
});

test('argument handling matches the CLI conventions', async () => {
  const help = capture();
  assert.equal(await doctorCommand({ argv: ['--help'], probes: { output: help.output } }), 0);
  assert.equal(help.stdout, `${DOCTOR_USAGE}\n`);
  assert.equal(help.stderr, '');

  const short = capture();
  assert.equal(await doctorCommand({ argv: ['-h'], probes: { output: short.output } }), 0);
  assert.equal(short.stdout, `${DOCTOR_USAGE}\n`);

  const unknown = capture();
  assert.equal(await doctorCommand({ argv: ['--nope'], probes: { output: unknown.output } }), 1);
  assert.equal(unknown.stdout, '');
  assert.equal(unknown.stderr, `Error: Unknown argument: --nope\n\n${DOCTOR_USAGE}\n`);

  const badTimeout = capture();
  assert.equal(
    await doctorCommand({ argv: ['--timeout', 'soon'], probes: { output: badTimeout.output } }),
    1,
  );
  assert.match(
    badTimeout.stderr,
    /^Error: --timeout must be a positive integer number of milliseconds$/m,
  );
});

test('help never runs a probe, so --help stays free even in a broken environment', async () => {
  let probed = false;
  const printed = capture();
  const code = await doctorCommand({
    argv: ['--help'],
    probes: {
      output: printed.output,
      providers: async () => { probed = true; return []; },
      decoder: async () => { probed = true; return sharpAbsent(); },
    },
  });

  assert.equal(code, 0);
  assert.equal(probed, false);
});

test('capability rendering keeps undeclared bounds undeclared', () => {
  assert.equal(describeCapabilities(null), 'not declared');
  assert.equal(describeCapabilities('already prose'), 'already prose');
  assert.equal(
    describeCapabilities({ minWidth: 64, maxWidth: 1024, transparency: true }),
    'width 64-1024px; transparency: yes; seed: no; references: no; negative prompt: no',
  );
  assert.equal(
    describeCapabilities({ minPixels: 1024 }),
    'total pixels from 1024; transparency: no; seed: no; references: no; negative prompt: no',
  );
  assert.doesNotMatch(describeCapabilities({}), /unlimited|infinite|none/);
});

test('the report is a single stdout document with no stderr contamination', async () => {
  const result = await run({ providers: [codexRow(true)], decoder: sharpAbsent });

  assert.equal(result.stderr, '');
  assert.ok(result.stdout.startsWith('Pixelproof doctor\n'));
  assert.match(result.stdout, /^Decoder$/m);
  assert.match(result.stdout, /^Summary$/m);
});
