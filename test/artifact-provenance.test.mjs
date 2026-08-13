import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, stat, utimes, writeFile } from 'node:fs/promises';
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
  runReference,
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
    // Sampled from the filesystem under test, not from Date.now(): on Linux the
    // two are different clocks and the fine-grained one runs ahead of the mtimes
    // this directory hands out, which would make `fresh.png` below look stale.
    const { ms: notBefore } = await runReference(root);
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

/**
 * Regression for the two-clock freshness bug.
 *
 * The assertions below are host-independent by construction: every value in the
 * ordering check comes from the filesystem itself, so it holds identically on a
 * coarse-mtime host (Linux, where the bug reproduced) and a fine-grained one
 * (Windows, where it never did). A reference taken from `Date.now()` instead
 * fails the upper bound on any host whose mtime clock lags the wall clock, and
 * fails `startedAtSource` everywhere — so a revert cannot pass quietly on the
 * developer's machine and break only in CI, which is how this shipped.
 */
test('the run start is sampled from the filesystem that stamps the artifacts, not from Date.now()', async () => {
  const root = await temporaryDirectory('pixelproof-provenance-clock-');
  try {
    const before = path.join(root, 'before.bin');
    await writeFile(before, 'written before the run started');
    const beforeMtimeMs = (await stat(before)).mtimeMs;

    const target = await prepareTarget(path.join(root, 'out', 'result.png'));

    const after = path.join(root, 'after.bin');
    await writeFile(after, 'written after the run started');
    const afterMtimeMs = (await stat(after)).mtimeMs;

    assert.equal(target.startedAtSource, 'filesystem');
    assert.ok(
      target.startedAt >= beforeMtimeMs,
      'a run start behind files that already existed would adopt them as fresh',
    );
    assert.ok(
      target.startedAt <= afterMtimeMs,
      'a run start ahead of the mtimes this filesystem hands out rejects the run own artifacts',
    );

    await writeFile(target.path, 'produced by this run');
    const produced = await validateTarget(target);
    assert.equal(produced.fresh, true, 'a file written after the run started is a product of the run');
    assert.equal(produced.state, PRODUCED);

    // The guarantee that must not weaken while fixing the one above.
    await writeStale(target.path, 'left over from last week');
    const stale = await validateTarget(target);
    assert.equal(stale.fresh, false, 'a days-old file is still not a product of this run');
    assert.equal(stale.state, STALE);
  } finally {
    await removeTemporaryDirectory(root);
  }
});

test('a run reference falls back to the clock, visibly, when the filesystem cannot be sampled', async () => {
  const root = await temporaryDirectory('pixelproof-provenance-reference-');
  try {
    const sampled = await runReference(root);
    assert.equal(sampled.source, 'filesystem');
    assert.equal(Number.isFinite(sampled.ms), true);
    assert.deepEqual(await readdir(root), [], 'the probe marker must not survive the sample');

    // A directory that does not exist is the recovery-scan case: a provider that
    // has never run has no session directory to sample.
    const missing = await runReference(path.join(root, 'never-created'), { fallback: 1234 });
    assert.deepEqual(missing, { ms: 1234, source: 'clock' });

    await assert.rejects(runReference(''), TypeError);
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
  await assert.rejects(prepareTarget('out.png', { startedAt: 'now' }), TypeError);
  await assert.rejects(validateTarget(null), TypeError);
  await assert.rejects(adoptArtifact({ source: 'a.png', target: null }), TypeError);
});
