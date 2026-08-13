import assert from 'node:assert/strict';
import { mkdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  MISSING,
  PRODUCED,
  STALE,
  adoptArtifact,
  artifactStatus,
  collectFreshArtifacts,
  prepareTarget,
  selectArtifact,
  validateTarget,
} from '../core/artifacts/provenance.mjs';
import { removeTemporaryDirectory, temporaryDirectory } from './helpers/compat-harness.mjs';

const LONG_AGO = new Date('2020-01-01T00:00:00.000Z');

async function writeStale(filePath, contents) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents);
  await utimes(filePath, LONG_AGO, LONG_AGO);
}

test('a file counts as produced only when it exists and is not older than the run', async () => {
  const root = await temporaryDirectory('pixelproof-provenance-status-');
  try {
    const notBefore = Date.now();
    const missing = path.join(root, 'nothing.png');
    const stale = path.join(root, 'stale.png');
    const fresh = path.join(root, 'fresh.png');

    await writeStale(stale, 'old');
    await writeFile(fresh, 'new');

    assert.deepEqual(await artifactStatus(missing, notBefore), {
      exists: false,
      fresh: false,
      mtimeMs: null,
      state: MISSING,
    });

    const staleStatus = await artifactStatus(stale, notBefore);
    assert.equal(staleStatus.exists, true);
    assert.equal(staleStatus.fresh, false, 'existence is not production');
    assert.equal(staleStatus.state, STALE);

    const freshStatus = await artifactStatus(fresh, notBefore);
    assert.equal(freshStatus.fresh, true);
    assert.equal(freshStatus.state, PRODUCED);
  } finally {
    await removeTemporaryDirectory(root);
  }
});

test('prepareTarget resolves the path, creates its directory, and freezes the run start', async () => {
  const root = await temporaryDirectory('pixelproof-provenance-prepare-');
  try {
    const target = await prepareTarget(path.join(root, 'nested', 'deep', 'out.png'));

    assert.equal(path.isAbsolute(target.path), true);
    assert.equal(target.filename, 'out.png');
    assert.equal((await stat(target.directory)).isDirectory(), true);
    assert.equal(target.preexisting.state, MISSING);
    assert.throws(() => {
      target.startedAt = 0;
    }, TypeError, 'a mutable run start is a freshness check that can be argued out of failing');
  } finally {
    await removeTemporaryDirectory(root);
  }
});

test('a stale pre-existing target is rejected without being modified or removed', async () => {
  const root = await temporaryDirectory('pixelproof-provenance-stale-');
  try {
    const outPath = path.join(root, 'out.png');
    await writeStale(outPath, 'pre-existing target');
    const before = await stat(outPath);

    const target = await prepareTarget(outPath);
    const status = await validateTarget(target);

    assert.equal(status.exists, true);
    assert.equal(status.fresh, false);
    assert.equal(status.state, STALE);
    assert.equal(await readFile(outPath, 'utf8'), 'pre-existing target');
    assert.equal((await stat(outPath)).mtimeMs, before.mtimeMs);
  } finally {
    await removeTemporaryDirectory(root);
  }
});

test('recovery candidates are held to the same freshness rule as the target', async () => {
  const root = await temporaryDirectory('pixelproof-provenance-candidates-');
  try {
    const sessions = path.join(root, 'sessions');
    await writeStale(path.join(sessions, 'old-session', 'a.png'), 'stale');
    const target = await prepareTarget(path.join(root, 'out', 'result.png'));
    await mkdir(path.join(sessions, 'new-session'), { recursive: true });
    await writeFile(path.join(sessions, 'new-session', 'b.png'), 'fresh');
    await writeFile(path.join(sessions, 'new-session', 'notes.txt'), 'ignored');

    const candidates = await collectFreshArtifacts({
      roots: [sessions, path.join(root, 'does-not-exist')],
      notBefore: target.startedAt,
      accept: ({ name }) => name.toLowerCase().endsWith('.png'),
    });

    assert.deepEqual(
      candidates.map((candidate) => path.basename(candidate.path)),
      ['b.png'],
      'a stale candidate must not be adoptable just because it was found by a scan',
    );

    const chosen = selectArtifact(candidates);
    assert.equal(chosen.ambiguous, false);
    const status = await adoptArtifact({ source: chosen.path, target });

    assert.equal(status.fresh, true);
    assert.equal(await readFile(target.path, 'utf8'), 'fresh');
    await assert.rejects(stat(chosen.path), { code: 'ENOENT' }, 'the artifact moved, it was not copied');
  } finally {
    await removeTemporaryDirectory(root);
  }
});

test('more than one fresh candidate is ambiguous, and the strict policy refuses to guess', async () => {
  const root = await temporaryDirectory('pixelproof-provenance-ambiguous-');
  try {
    const notBefore = Date.now();
    const first = { path: path.join(root, 'a.png'), mtimeMs: notBefore + 10 };
    const second = { path: path.join(root, 'b.png'), mtimeMs: notBefore + 20 };

    const newest = selectArtifact([second, first]);
    assert.equal(newest.path, second.path, 'v1 behaviour: newest wins');
    assert.equal(newest.ambiguous, true);

    const strict = selectArtifact([second, first], { policy: 'reject' });
    assert.equal(strict.path, null, 'a run that cannot prove which artifact is its own has none');
    assert.equal(strict.ambiguous, true);

    assert.deepEqual(selectArtifact([]), { path: null, ambiguous: false, candidates: [] });
  } finally {
    await removeTemporaryDirectory(root);
  }
});

test('provenance rejects a run start it cannot trust', async () => {
  await assert.rejects(artifactStatus('anything.png', undefined), TypeError);
  await assert.rejects(prepareTarget(''), TypeError);
  await assert.rejects(validateTarget(null), TypeError);
  await assert.rejects(adoptArtifact({ source: 'a.png', target: null }), TypeError);
});
