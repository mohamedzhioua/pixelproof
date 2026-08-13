import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  isolateVerifier,
  removeTemporaryDirectory,
  runScript,
  temporaryDirectory,
  writePng,
} from './helpers/compat-harness.mjs';

test('makes skipped checks legible and strict-mode failures machine-readable', async () => {
  // The temp root comes from the harness, which returns a *realpath*. On macOS
  // `os.tmpdir()` is `/var/folders/...`, a symlink to `/private/var/folders/...`,
  // and a tree built under the unresolved path is not reliably the tree the
  // spawned Node resolves and runs — this test used to hand-roll `mkdtemp` and
  // produced empty stdout on every macOS runner while passing on Linux and
  // Windows. Isolation likewise goes through `isolateVerifier()` rather than a
  // second copy of the copy logic: one mechanism, exercised by every test that
  // needs it, cannot drift into a per-file variant that only fails on one OS.
  const root = await temporaryDirectory('pixelproof-no-sharp-');
  try {
    const imagePath = path.join(root, 'probe.png');
    const specPath = path.join(root, 'spec.json');
    const isolatedVerifier = await isolateVerifier(root);
    await Promise.all([
      writePng(imagePath, 1, 1),
      writeFile(specPath, JSON.stringify({
        mechanical: {
          width: 1,
          height: 1,
          aspect: '1:1',
          corners: { expect: '#FFFFFF', tolerance: 3 },
          alpha: 'opaque',
        },
      })),
    ]);
    const arguments_ = ['--file', imagePath, '--spec', specPath];

    const defaultResult = runScript(isolatedVerifier, arguments_);
    assert.equal(defaultResult.status, 0, defaultResult.stderr);
    assert.match(
      defaultResult.stdout,
      /Mechanical verification: PASS \(2 checks SKIPPED - not verified\)/,
    );

    const strictResult = runScript(isolatedVerifier, [...arguments_, '--strict']);
    assert.equal(strictResult.status, 1, strictResult.stderr);
    assert.match(
      strictResult.stdout,
      /Mechanical verification: FAIL \(2 checks SKIPPED - not verified\)/,
    );

    const jsonResult = runScript(isolatedVerifier, [...arguments_, '--strict', '--json']);
    assert.equal(jsonResult.status, 1, jsonResult.stderr);
    const parsed = JSON.parse(jsonResult.stdout);
    assert.deepEqual(
      {
        passed: parsed.passed,
        failed: parsed.failed,
        skipped: parsed.skipped,
        strict: parsed.strict,
        ok: parsed.ok,
      },
      { passed: 3, failed: 0, skipped: 2, strict: true, ok: false },
    );
  } finally {
    await removeTemporaryDirectory(root);
  }
});
