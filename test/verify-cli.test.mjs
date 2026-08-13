import assert from 'node:assert/strict';
import { copyFile, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const onePixelPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function runVerifier(scriptPath, imagePath, specPath, ...extraArguments) {
  return spawnSync(
    process.execPath,
    [scriptPath, '--file', imagePath, '--spec', specPath, ...extraArguments],
    { encoding: 'utf8' },
  );
}

test('makes skipped checks legible and strict-mode failures machine-readable', async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'pixelproof-no-sharp-'));
  const isolatedVerifier = path.join(temporaryDirectory, 'scripts', 'verify.mjs');
  const imagePath = path.join(temporaryDirectory, 'probe.png');
  const specPath = path.join(temporaryDirectory, 'spec.json');

  try {
    // Copy the module tree, not just the entry file: the verifier imports
    // ../core/, so an isolated copy has to preserve that layout. The isolation
    // itself comes from the temp directory having no node_modules, which is what
    // makes `sharp` unresolvable — that, and not the file layout, is the
    // condition under test.
    await mkdir(path.dirname(isolatedVerifier), { recursive: true });
    await cp(
      path.join(repositoryRoot, 'core'),
      path.join(temporaryDirectory, 'core'),
      { recursive: true },
    );
    await Promise.all([
      copyFile(path.join(repositoryRoot, 'scripts', 'verify.mjs'), isolatedVerifier),
      writeFile(imagePath, Buffer.from(onePixelPng, 'base64')),
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

    const defaultResult = runVerifier(isolatedVerifier, imagePath, specPath);
    assert.equal(defaultResult.status, 0);
    assert.match(
      defaultResult.stdout,
      /Mechanical verification: PASS \(2 checks SKIPPED - not verified\)/,
    );

    const strictResult = runVerifier(isolatedVerifier, imagePath, specPath, '--strict');
    assert.equal(strictResult.status, 1);
    assert.match(
      strictResult.stdout,
      /Mechanical verification: FAIL \(2 checks SKIPPED - not verified\)/,
    );

    const jsonResult = runVerifier(isolatedVerifier, imagePath, specPath, '--strict', '--json');
    assert.equal(jsonResult.status, 1);
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
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
