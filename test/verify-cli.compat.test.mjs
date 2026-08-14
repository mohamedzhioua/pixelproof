import assert from 'node:assert/strict';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  hasSharp,
  isolateVerifier,
  normaliseResult,
  normaliseText,
  removeTemporaryDirectory,
  repositoryRoot,
  runScript,
  temporaryDirectory,
  verifierPath,
  writePng,
} from './helpers/compat-harness.mjs';

/**
 * The frozen banner, held byte for byte.
 *
 * The three `--judge*` / `--run-dir` lines and the `Host judgement:` section were
 * added on 2026-08-13 under the amendment to ADR 0003, which permits purely
 * additive lines documenting a new flag while every existing line stays
 * byte-identical. Updating this constant is the deliberate act that amendment
 * requires: it is the evidence, so it is edited with intent, and it is never
 * deleted or loosened into a substring match to make a diff go away. Every line
 * that was here before is still here, unchanged and in the same order.
 */
const VERIFIER_USAGE = `pixelproof mechanical verifier

Usage:
  node scripts/verify.mjs --file <path> [--spec <spec.json>] [--json] [--strict]

Options:
  --file <path>       Image to inspect (required)
  --spec <path>       JSON spec containing a mechanical block
  --json              Print a machine-readable result object
  --strict            Treat skipped checks as failures
  --judge host        Ask the calling agent to judge the spec's semantic assertions
  --judge codex       Judge them here by running the Codex CLI (see below)
  --judge-deadline    How long the checklist stays answerable (default 24h)
  --run-dir <path>    Run root; also PIXELPROOF_RUN_ROOT (default .pixelproof/runs)
  -h, --help          Show this help

Host judgement:
  --judge host writes a checklist and exits 2: an outstanding judgement, never a
  pass. Answer it with \`pixelproof judge submit\`. Needs a .png and a spec with at
  least one "semantic" entry. --judge-deadline takes a duration such as 6h or 90m;
  a unit is required, because a bare number could be seconds or milliseconds.

Subprocess judgement:
  --judge codex runs the judge here and finishes in one invocation: 0 accepted,
  1 rejected. It never exits 2, because nothing is left outstanding, and
  --judge-deadline means nothing to it (PIXELPROOF_JUDGE_TIMEOUT_MS bounds the
  call instead). A judge that is not installed is refused before any work.
  An "unsure" verdict is a rejection here: escalation goes to a host, and this
  panel has none. Naming more than one judge is refused; panels are not wired.
`;

const RESULT_FIELDS = [
  'checks',
  'decoder',
  'degraded',
  'failed',
  'file',
  'notes',
  'ok',
  'passed',
  'skipped',
  'spec',
  'strict',
  'summary',
  'warnings',
];

test('freezes verify help, parser errors, required options, exit codes, and output channels', () => {
  const help = normaliseResult(runScript(verifierPath, ['--help']));
  assert.equal(help.status, 0);
  assert.equal(help.stdout, `${VERIFIER_USAGE}\n`);
  assert.equal(help.stderr, '');

  const missingFile = normaliseResult(runScript(verifierPath));
  assert.equal(missingFile.status, 1);
  assert.equal(missingFile.stdout, '');
  assert.equal(missingFile.stderr, `Error: --file is required\n\n${VERIFIER_USAGE}\n`);

  const missingValue = normaliseResult(runScript(verifierPath, ['--file']));
  assert.equal(missingValue.status, 1);
  assert.equal(missingValue.stdout, '');
  assert.equal(missingValue.stderr, `Error: --file requires a value\n\n${VERIFIER_USAGE}\n`);

  const unknown = normaliseResult(runScript(verifierPath, ['--unknown']));
  assert.equal(unknown.status, 1);
  assert.equal(unknown.stdout, '');
  assert.equal(unknown.stderr, `Error: Unknown argument: --unknown\n\n${VERIFIER_USAGE}\n`);
});

test('represents every README verify example and freezes human and JSON result contracts', async () => {
  const root = await temporaryDirectory('pixelproof-verify-readme-');
  try {
    const outputDirectory = path.join(root, 'output');
    const specDirectory = path.join(root, 'specs');
    await Promise.all([mkdir(outputDirectory), mkdir(specDirectory)]);
    await Promise.all([
      writePng(path.join(outputDirectory, 'lamp.png'), 1254, 1254),
      copyFile(
        path.join(repositoryRoot, 'specs', 'product-hero.example.json'),
        path.join(specDirectory, 'product-hero.example.json'),
      ),
    ]);

    const arguments_ = [
      '--file', 'output/lamp.png', '--spec', 'specs/product-hero.example.json',
    ];
    const human = normaliseResult(runScript(verifierPath, arguments_, { cwd: root }), { TMP: root });
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /^Mechanical verification: PASS/m);
    assert.match(human.stdout, /^File: <TMP>\/output\/lamp\.png$/m);
    assert.match(human.stdout, /^Decoder: (sharp|png-header-fallback)$/m);
    assert.match(human.stdout, /width/);
    assert.match(human.stdout, /height/);
    assert.match(human.stdout, /aspect/);

    const jsonProcess = runScript(verifierPath, [...arguments_, '--json'], { cwd: root });
    assert.equal(jsonProcess.status, 0, jsonProcess.stderr);
    assert.equal(jsonProcess.stderr, '');
    const json = JSON.parse(jsonProcess.stdout);
    assert.deepEqual(Object.keys(json).sort(), RESULT_FIELDS);
    assert.equal(normaliseText(json.file, { TMP: root }), '<TMP>/output/lamp.png');
    assert.equal(
      normaliseText(json.spec, { TMP: root }),
      '<TMP>/specs/product-hero.example.json',
    );
    assert.deepEqual(json.summary, {
      passed: json.passed,
      failed: json.failed,
      skipped: json.skipped,
    });
    assert.equal(json.strict, false);
    assert.equal(json.ok, true);

    const strict = normaliseResult(
      runScript(verifierPath, [...arguments_, '--strict'], { cwd: root }),
      { TMP: root },
    );
    if (await hasSharp()) {
      assert.equal(strict.status, 0, strict.stderr);
      assert.match(strict.stdout, /Mechanical verification: PASS/);
      assert.match(strict.stdout, /Summary: 5 passed, 0 failed, 0 skipped/);
    } else {
      assert.equal(strict.status, 1);
      assert.match(
        strict.stdout,
        /Mechanical verification: FAIL \(2 checks SKIPPED - not verified\)/,
      );
      assert.match(strict.stdout, /Summary: 3 passed, 0 failed, 2 skipped/);
      assert.match(strict.stderr, /Warning: sharp is unavailable/);
    }
  } finally {
    await removeTemporaryDirectory(root);
  }
});

test('asserts the documented no-sharp SKIP path instead of skipping the test', async () => {
  const root = await temporaryDirectory('pixelproof-verify-isolated-');
  try {
    const imagePath = path.join(root, 'probe.png');
    const specPath = path.join(root, 'spec.json');
    const isolatedVerifier = await isolateVerifier(root);
    await Promise.all([
      writePng(imagePath, 2, 2),
      writeFile(specPath, JSON.stringify({
        mechanical: {
          width: 2,
          height: 2,
          aspect: '1:1',
          corners: { expect: '#FFFFFF', tolerance: 3 },
          alpha: 'opaque',
        },
      })),
    ]);

    const normal = normaliseResult(runScript(isolatedVerifier, [
      '--file', imagePath, '--spec', specPath,
    ]), { TMP: root });
    assert.equal(normal.status, 0, normal.stderr);
    assert.match(
      normal.stdout,
      /Mechanical verification: PASS \(2 checks SKIPPED - not verified\)/,
    );
    assert.match(normal.stdout, /Summary: 3 passed, 0 failed, 2 skipped/);
    assert.match(normal.stderr, /Warning: sharp is unavailable/);

    const strict = runScript(isolatedVerifier, [
      '--file', imagePath, '--spec', specPath, '--strict', '--json',
    ]);
    assert.equal(strict.status, 1, strict.stderr);
    assert.equal(strict.stderr, '');
    const parsed = JSON.parse(strict.stdout);
    assert.deepEqual(
      {
        decoder: parsed.decoder,
        passed: parsed.passed,
        failed: parsed.failed,
        skipped: parsed.skipped,
        strict: parsed.strict,
        ok: parsed.ok,
      },
      {
        decoder: 'png-header-fallback',
        passed: 3,
        failed: 0,
        skipped: 2,
        strict: true,
        ok: false,
      },
    );
  } finally {
    await removeTemporaryDirectory(root);
  }
});

test('freezes empty mechanical behavior and ordinary failed-check exit status', async () => {
  const root = await temporaryDirectory('pixelproof-verify-empty-');
  try {
    const imagePath = path.join(root, 'probe.png');
    const emptySpec = path.join(root, 'empty.json');
    const failingSpec = path.join(root, 'failing.json');
    await Promise.all([
      writePng(imagePath, 1, 1),
      writeFile(emptySpec, JSON.stringify({ mechanical: {} })),
      writeFile(failingSpec, JSON.stringify({ mechanical: { width: 2 } })),
    ]);

    const empty = normaliseResult(runScript(verifierPath, [
      '--file', imagePath, '--spec', emptySpec,
    ]), { TMP: root });
    assert.equal(empty.status, 0, empty.stderr);
    assert.match(empty.stdout, /Mechanical verification: PASS/);
    assert.match(
      empty.stdout,
      /Note: No mechanical checks were declared; the mechanical tier passes by default\./,
    );
    assert.match(empty.stdout, /Summary: 0 passed, 0 failed, 0 skipped/);

    const failed = runScript(verifierPath, [
      '--file', imagePath, '--spec', failingSpec, '--json',
    ]);
    assert.equal(failed.status, 1, failed.stderr);
    assert.equal(failed.stderr, '');
    const parsed = JSON.parse(failed.stdout);
    assert.equal(parsed.passed, 0);
    assert.equal(parsed.failed, 1);
    assert.equal(parsed.skipped, 0);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.checks[0].name, 'width');
    assert.equal(parsed.checks[0].status, 'FAIL');
  } finally {
    await removeTemporaryDirectory(root);
  }
});

test('freezes invalid JSON, spec-shape, and check errors in human and JSON modes', async () => {
  const root = await temporaryDirectory('pixelproof-verify-errors-');
  try {
    const imagePath = path.join(root, 'probe.png');
    const invalidJson = path.join(root, 'invalid.json');
    const invalidShape = path.join(root, 'shape.json');
    const invalidCheck = path.join(root, 'check.json');
    await Promise.all([
      writePng(imagePath, 1, 1),
      writeFile(invalidJson, '{'),
      writeFile(invalidShape, JSON.stringify({ mechanical: [] })),
      writeFile(invalidCheck, JSON.stringify({ mechanical: { width: 0 } })),
    ]);

    const syntax = normaliseResult(runScript(verifierPath, [
      '--file', imagePath, '--spec', invalidJson,
    ]), { TMP: root });
    assert.equal(syntax.status, 1);
    assert.equal(syntax.stdout, '');
    assert.match(syntax.stderr, /^Verification error: /);

    const shape = normaliseResult(runScript(verifierPath, [
      '--file', imagePath, '--spec', invalidShape,
    ]), { TMP: root });
    assert.equal(shape.status, 1);
    assert.equal(shape.stderr, 'Verification error: spec.mechanical must be an object when present\n');

    const check = runScript(verifierPath, [
      '--file', imagePath, '--spec', invalidCheck, '--strict', '--json',
    ]);
    assert.equal(check.status, 1, check.stderr);
    assert.equal(check.stderr, '');
    assert.deepEqual(JSON.parse(check.stdout), {
      passed: 0,
      failed: 1,
      skipped: 0,
      strict: true,
      ok: false,
      error: 'mechanical.width must be a positive integer',
    });
  } finally {
    await removeTemporaryDirectory(root);
  }
});
