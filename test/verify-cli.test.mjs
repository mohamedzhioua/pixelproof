import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imagePath = path.join(repositoryRoot, '.pixelproof-scratch', 'probe.png');
const specPath = path.join(repositoryRoot, 'specs', 'product-hero.example.json');

function runVerifier(scriptPath, ...extraArguments) {
  return spawnSync(
    process.execPath,
    [scriptPath, '--file', imagePath, '--spec', specPath, ...extraArguments],
    { encoding: 'utf8' },
  );
}

test('makes skipped checks legible and strict-mode failures machine-readable', async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'pixelproof-no-sharp-'));
  const isolatedVerifier = path.join(temporaryDirectory, 'verify.mjs');
  await copyFile(path.join(repositoryRoot, 'scripts', 'verify.mjs'), isolatedVerifier);

  try {
    const defaultResult = runVerifier(isolatedVerifier);
    assert.equal(defaultResult.status, 0);
    assert.match(
      defaultResult.stdout,
      /Mechanical verification: PASS \(2 checks SKIPPED - not verified\)/,
    );

    const strictResult = runVerifier(isolatedVerifier, '--strict');
    assert.equal(strictResult.status, 1);
    assert.match(
      strictResult.stdout,
      /Mechanical verification: FAIL \(2 checks SKIPPED - not verified\)/,
    );

    const jsonResult = runVerifier(isolatedVerifier, '--strict', '--json');
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
