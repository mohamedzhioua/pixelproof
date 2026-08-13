import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  ABANDONED,
  ACCEPTED,
  PENDING_JUDGEMENT,
  REJECTED,
  RUNNING,
  RUN_ID_PATTERN,
  RUN_ROOT_ENV,
  RUN_STATES,
  RunError,
  acceptedFor,
  assertTransition,
  buildReport,
  canTransition,
  createRun,
  describeRunRoot,
  finaliseRun,
  isRunId,
  listOpenRuns,
  listRuns,
  newRunId,
  readReport,
  readRun,
  recordAttempt,
  renderReportMarkdown,
  resolveRunDirectory,
  transitionRun,
} from '../core/run/index.mjs';
import { buildResult } from '../core/verification/result.mjs';
import { removeTemporaryDirectory, temporaryDirectory } from './helpers/compat-harness.mjs';

/**
 * Run directories and persisted evidence (ADR 0009 §2, ADR 0014).
 *
 * Nothing here spawns a process, touches the network, or needs `sharp`: the run
 * store is stdlib-only by construction, so the degraded lane exercises exactly
 * the same code as the full one.
 */

/** A verification record in the shape `core/verification/result.mjs` produces. */
function verification({ ok = true, skipped = 0, strict = false } = {}) {
  const checks = [
    { name: 'width', expected: 1024, actual: 1024, passed: ok, status: ok ? 'PASS' : 'FAIL' },
  ];
  for (let index = 0; index < skipped; index += 1) {
    checks.push({ name: `skipped-${index}`, expected: 'x', actual: 'no decoder', passed: null, status: 'SKIP' });
  }
  return buildResult({ file: 'attempt.png', decoder: 'none', degraded: true, checks, strict });
}

async function writeArtifact(directory, name, contents) {
  const file = path.join(directory, name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents);
  return file;
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

test('run ids carry a Windows-legal timestamp and are unique at the same instant', () => {
  const fixed = new Date('2026-08-13T09:21:04.512Z');
  const id = newRunId({ now: fixed });

  assert.match(id, RUN_ID_PATTERN);
  assert.ok(id.startsWith('2026-08-13T09-21-04Z-'), `expected a hyphenated UTC stamp, got ${id}`);
  assert.ok(!id.includes(':'), 'a colon is not a legal Windows filename character (ADR 0009 §2)');

  // Same clock reading, 2000 ids: the timestamp half cannot separate them, so
  // uniqueness rests entirely on the random half.
  const ids = new Set();
  for (let index = 0; index < 2000; index += 1) ids.add(newRunId({ now: fixed }));
  assert.equal(ids.size, 2000, 'run ids collided within one second');
});

test('malformed run ids are refused before any path is built from them', () => {
  const rejected = [
    '2026-08-13T09:21:04Z-a3f9c1d2', // ISO colons
    '2026-08-13T09-21-04Z-A3F9C1D2', // uppercase hex
    '2026-08-13T09-21-04Z-a3f9c1d', // seven hex
    '2026-08-13T09-21-04Z-a3f9c1d22', // nine hex
    '2026-08-13T09-21-04-a3f9c1d2', // no Z
    '../../etc',
    '..',
    '',
    null,
  ];

  for (const value of rejected) {
    assert.equal(isRunId(value), false, `${JSON.stringify(value)} must not be a run id`);
    assert.throws(
      () => resolveRunDirectory({ runId: value, root: '/tmp/runs' }),
      (error) => error instanceof RunError && error.code === 'RUN_ID_MALFORMED',
      `${JSON.stringify(value)} must be refused as a run id`,
    );
  }

  assert.equal(isRunId(newRunId()), true);
});

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

test('every illegal state transition is refused, and terminal states are final', () => {
  // Written out independently of core/run/state.mjs on purpose: a test that
  // imported the same table it checks would pass for any table.
  const legal = new Set([
    `${RUNNING}->${PENDING_JUDGEMENT}`,
    `${RUNNING}->${ACCEPTED}`,
    `${RUNNING}->${REJECTED}`,
    `${RUNNING}->${ABANDONED}`,
    `${PENDING_JUDGEMENT}->${PENDING_JUDGEMENT}`,
    `${PENDING_JUDGEMENT}->${ACCEPTED}`,
    `${PENDING_JUDGEMENT}->${REJECTED}`,
    `${PENDING_JUDGEMENT}->${ABANDONED}`,
  ]);

  const refused = [];
  for (const from of RUN_STATES) {
    for (const to of RUN_STATES) {
      const key = `${from}->${to}`;
      if (legal.has(key)) {
        assert.equal(canTransition(from, to), true, `${key} should be legal`);
        assert.equal(assertTransition(from, to), to);
        continue;
      }

      assert.equal(canTransition(from, to), false, `${key} should be refused`);
      assert.throws(
        () => assertTransition(from, to),
        (error) => error instanceof RunError && error.code === 'RUN_STATE_TRANSITION_REFUSED',
        `${key} must be refused`,
      );
      refused.push(key);
    }
  }

  // 25 pairs, 8 legal. Asserted as a count so a shrinking state set cannot make
  // this test vacuous.
  assert.equal(RUN_STATES.length, 5);
  assert.equal(refused.length, 17);

  // The two that matter most, named for the record.
  assert.ok(refused.includes(`${ACCEPTED}->${RUNNING}`), 'a closed run must never reopen');
  assert.ok(refused.includes(`${PENDING_JUDGEMENT}->${RUNNING}`), 'submit records verdicts, it never re-runs');

  for (const state of [ACCEPTED, REJECTED, ABANDONED]) {
    for (const to of RUN_STATES) {
      assert.equal(canTransition(state, to), false, `${state} is terminal`);
    }
  }

  assert.throws(() => assertTransition('running', 'finished'), (error) => error instanceof RunError);
  assert.throws(() => assertTransition('idle', 'accepted'), (error) => error instanceof RunError);
});

test('accepted is a projection of state, never an independent field', () => {
  assert.equal(acceptedFor(RUNNING), null);
  assert.equal(acceptedFor(PENDING_JUDGEMENT), false, 'ADR 0009 §4: pending says accepted: false out loud');
  assert.equal(acceptedFor(ACCEPTED), true);
  assert.equal(acceptedFor(REJECTED), false);
  assert.equal(acceptedFor(ABANDONED), false);
  assert.throws(() => acceptedFor('anything-else'), (error) => error instanceof RunError);
});

// ---------------------------------------------------------------------------
// Run root
// ---------------------------------------------------------------------------

test('the run root is --run-dir, then the environment, then .pixelproof/runs', () => {
  const cwd = path.resolve('/projects/site');

  assert.deepEqual(describeRunRoot({ cwd, env: {} }), {
    path: path.join(cwd, '.pixelproof', 'runs'),
    source: 'default',
  });

  assert.deepEqual(describeRunRoot({ cwd, env: { [RUN_ROOT_ENV]: 'ci-evidence' } }), {
    path: path.join(cwd, 'ci-evidence'),
    source: 'env',
  });

  assert.deepEqual(
    describeRunRoot({ cwd, runDir: 'chosen', env: { [RUN_ROOT_ENV]: 'ci-evidence' } }),
    { path: path.join(cwd, 'chosen'), source: 'option' },
  );

  // An empty value is not an override; it is a mistake, and falling through is
  // safer than resolving the run root to the working directory itself.
  assert.equal(describeRunRoot({ cwd, runDir: '   ', env: {} }).source, 'default');
});

test('reading and enumerating never create anything on disk', async () => {
  const root = await temporaryDirectory('pixelproof-run-readonly-');
  try {
    const runRoot = path.join(root, 'never-written');
    assert.deepEqual(await listRuns({ root: runRoot }), []);
    assert.deepEqual(await listOpenRuns({ root: runRoot }), []);
    assert.deepEqual(await readdir(root), [], 'enumeration must not create the run root');
  } finally {
    await removeTemporaryDirectory(root);
  }
});

// ---------------------------------------------------------------------------
// Round trip
// ---------------------------------------------------------------------------

test('a run round-trips through create, attempt, pending, and acceptance', async () => {
  const root = await temporaryDirectory('pixelproof-run-roundtrip-');
  try {
    const runRoot = path.join(root, 'runs');
    const created = await createRun({
      root: runRoot,
      command: 'generate',
      pixelproofVersion: '0.2.1',
      resolved: { provider: 'svg', judge: null, spec: 'hero.json' },
    });

    assert.equal(created.run.schema, 'pixelproof.run/1');
    assert.equal(created.run.state, RUNNING);
    assert.equal(created.run.accepted, null);
    assert.deepEqual(created.run.attempts, []);
    assert.equal(created.run.outcome, null);
    assert.equal(path.basename(created.directory), created.runId);
    assert.deepEqual(await readRun(created.directory), created.run, 'read must return exactly what was written');

    const source = await writeArtifact(root, 'candidate.png', 'not-really-a-png-but-bytes');
    const recorded = await recordAttempt(created.directory, {
      artifact: { path: source },
      verification: verification({ ok: true, skipped: 2 }),
    });

    assert.equal(recorded.attempt.schema, 'pixelproof.attempt/1');
    assert.equal(recorded.run.attempts.length, 1);

    const [attempt] = recorded.run.attempts;
    assert.equal(attempt.number, 1);
    assert.equal(attempt.artifact.path, 'attempt-1.png', 'envelope paths are relative to the run directory');
    assert.equal(attempt.files.verification, 'attempt-1.json');
    assert.equal(
      attempt.artifact.sha256,
      createHash('sha256').update('not-really-a-png-but-bytes').digest('hex'),
      'the digest describes the bytes in the run directory',
    );
    assert.equal(attempt.artifact.bytes, 'not-really-a-png-but-bytes'.length);
    assert.deepEqual(attempt.verification, {
      ok: true, passed: 1, failed: 0, skipped: 2, strict: false, degraded: true, decoder: 'none',
    });

    // The artifact really is in the run directory, byte-identical.
    assert.equal(
      await readFile(path.join(created.directory, 'attempt-1.png'), 'utf8'),
      'not-really-a-png-but-bytes',
    );

    const pending = await transitionRun(created.directory, PENDING_JUDGEMENT, {
      reason: { code: 'awaiting-host-judgement', message: 'checklist issued' },
    });
    assert.equal(pending.state, PENDING_JUDGEMENT);
    assert.equal(pending.accepted, false);
    assert.equal(pending.reasons.at(-1).code, 'awaiting-host-judgement');
    assert.equal(pending.outcome, null, 'a pending run has no outcome yet');

    const open = await listOpenRuns({ root: runRoot });
    assert.deepEqual(open.map((entry) => entry.runId), [created.runId]);

    const finalised = await finaliseRun(created.directory, { state: ACCEPTED, acceptedAttempt: 1 });
    assert.equal(finalised.run.state, ACCEPTED);
    assert.equal(finalised.run.accepted, true);
    assert.deepEqual(finalised.run.outcome, {
      state: ACCEPTED,
      reason: null,
      acceptedAttempt: 1,
      finalisedAt: finalised.run.updatedAt,
    });
    assert.deepEqual(await readRun(created.directory), finalised.run);
    assert.deepEqual(await listOpenRuns({ root: runRoot }), [], 'a finalised run is not open');
  } finally {
    await removeTemporaryDirectory(root);
  }
});

test('a closed run refuses further evidence and further transitions', async () => {
  const root = await temporaryDirectory('pixelproof-run-closed-');
  try {
    const created = await createRun({ root: path.join(root, 'runs'), command: 'generate' });
    const source = await writeArtifact(root, 'candidate.png', 'bytes');
    await recordAttempt(created.directory, { artifact: { path: source }, verification: verification() });
    await finaliseRun(created.directory, { state: ABANDONED, reason: 'judgement-abandoned' });

    await assert.rejects(
      recordAttempt(created.directory, { artifact: { path: source }, verification: verification() }),
      (error) => error instanceof RunError && error.code === 'RUN_CLOSED',
      'evidence cannot be appended to a run that already reported',
    );

    await assert.rejects(
      transitionRun(created.directory, PENDING_JUDGEMENT),
      (error) => error instanceof RunError && error.code === 'RUN_STATE_TRANSITION_REFUSED',
      'an abandoned run cannot reopen — this is what makes a replayed submission fail',
    );

    await assert.rejects(
      finaliseRun(created.directory, { state: ACCEPTED, acceptedAttempt: 1 }),
      (error) => error instanceof RunError && error.code === 'RUN_STATE_TRANSITION_REFUSED',
    );

    // Terminal states must be reached through finaliseRun, so the report is
    // written with them rather than after them.
    const second = await createRun({ root: path.join(root, 'runs'), command: 'generate' });
    await assert.rejects(
      transitionRun(second.directory, ACCEPTED),
      (error) => error instanceof RunError && error.code === 'RUN_STATE_TRANSITION_REFUSED',
    );

    // And a rejected run may not name an accepted attempt.
    await assert.rejects(
      finaliseRun(second.directory, { state: REJECTED, acceptedAttempt: 1 }),
      (error) => error instanceof RunError && error.code === 'RUN_STATE_TRANSITION_REFUSED',
    );
  } finally {
    await removeTemporaryDirectory(root);
  }
});

test('an attempt that was never recorded cannot be accepted', async () => {
  const root = await temporaryDirectory('pixelproof-run-phantom-');
  try {
    const created = await createRun({ root: path.join(root, 'runs') });
    await assert.rejects(
      finaliseRun(created.directory, { state: ACCEPTED, acceptedAttempt: 3 }),
      (error) => error instanceof RunError && error.code === 'RUN_NOT_FOUND',
    );
    assert.equal((await readRun(created.directory)).state, RUNNING, 'a refused finalisation changes nothing');
  } finally {
    await removeTemporaryDirectory(root);
  }
});

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

test('the report matches the run it was written from', async () => {
  const root = await temporaryDirectory('pixelproof-run-report-');
  try {
    const created = await createRun({ root: path.join(root, 'runs'), command: 'generate', pixelproofVersion: '0.2.1' });
    const first = await writeArtifact(root, 'one.png', 'first-bytes');
    const second = await writeArtifact(root, 'two.png', 'second-bytes');

    await recordAttempt(created.directory, { artifact: { path: first }, verification: verification({ ok: false }) });
    await recordAttempt(created.directory, { artifact: { path: second }, verification: verification({ ok: true, skipped: 1 }) });

    const { run, report } = await finaliseRun(created.directory, {
      state: ACCEPTED,
      acceptedAttempt: 2,
      reason: { code: 'mechanical-pass', message: 'all declared checks passed' },
    });

    assert.equal(report.schema, 'pixelproof.report/1');
    assert.equal(report.runId, run.runId);
    assert.equal(report.state, run.state);
    assert.equal(report.accepted, run.accepted);
    assert.deepEqual(report.outcome, run.outcome);
    assert.deepEqual(report.attempts, run.attempts);
    assert.deepEqual(report.reasons, run.reasons);
    assert.equal(report.pixelproofVersion, run.pixelproofVersion);
    assert.deepEqual(await readReport(created.directory), report);

    // Counts come from the decisive attempt, not from a sum across attempts:
    // attempt 1 failed, and its failure must not be added to the accepted one.
    assert.equal(report.decisiveAttempt, 2);
    assert.deepEqual(report.summary, { attempts: 2, passed: 1, failed: 0, skipped: 1 });

    const narrative = await readFile(path.join(created.directory, 'report.md'), 'utf8');
    assert.ok(narrative.startsWith(`# Pixelproof run ${run.runId}`));
    assert.ok(narrative.includes('Accepted on attempt 2'));
    assert.ok(!narrative.includes('pixelproof.report/1'), 'the narrative carries no schema; nothing may parse it');
    assert.ok(narrative.includes('read `report.json` from a program'));
  } finally {
    await removeTemporaryDirectory(root);
  }
});

test('an abandoned run still gets a report, and it says so', async () => {
  const root = await temporaryDirectory('pixelproof-run-abandoned-');
  try {
    const created = await createRun({ root: path.join(root, 'runs') });
    await transitionRun(created.directory, PENDING_JUDGEMENT);
    const { report } = await finaliseRun(created.directory, {
      state: ABANDONED,
      reason: { code: 'judgement-abandoned', message: 'deadline passed' },
    });

    assert.equal(report.accepted, false, 'an unanswered checklist is never a pass');
    assert.equal(report.outcome.reason, 'judgement-abandoned');
    assert.equal(report.decisiveAttempt, null);
    assert.deepEqual(report.summary, { attempts: 0, passed: 0, failed: 0, skipped: 0 });

    const narrative = renderReportMarkdown(report);
    assert.ok(narrative.includes('Abandoned'));
    assert.ok(narrative.includes('never a pass'));
    assert.ok(narrative.includes('judgement-abandoned'));
  } finally {
    await removeTemporaryDirectory(root);
  }
});

test('buildReport is pure and reads only the run record', () => {
  const report = buildReport({
    runId: '2026-08-13T09-21-04Z-a3f9c1d2',
    state: REJECTED,
    accepted: false,
    attempts: [
      { number: 1, verification: { ok: false, passed: 0, failed: 2, skipped: 1 } },
      { number: 2, verification: { ok: false, passed: 1, failed: 1, skipped: 0 } },
    ],
    outcome: { state: REJECTED, reason: 'mechanical-failure', acceptedAttempt: null, finalisedAt: '2026-08-13T09:30:00.000Z' },
    reasons: [],
    notes: [],
  }, { schema: 'pixelproof.report/1', generatedAt: '2026-08-13T09:30:00.000Z' });

  assert.equal(report.decisiveAttempt, 2, 'with nothing accepted the last attempt is the decisive one');
  assert.deepEqual(report.summary, { attempts: 2, passed: 1, failed: 1, skipped: 0 });
});

// ---------------------------------------------------------------------------
// Enumeration
// ---------------------------------------------------------------------------

test('runs are enumerated newest first by scanning, with no index file', async () => {
  const root = await temporaryDirectory('pixelproof-run-list-');
  try {
    const runRoot = path.join(root, 'runs');
    const ids = [];
    for (const stamp of ['2026-08-13T09:00:00.000Z', '2026-08-13T10:00:00.000Z', '2026-08-13T11:00:00.000Z']) {
      const created = await createRun({ root: runRoot, now: new Date(stamp) });
      ids.push(created.runId);
    }

    // Directories that are not run ids were never ours and are ignored.
    await mkdir(path.join(runRoot, 'scratch'), { recursive: true });
    await writeFile(path.join(runRoot, 'index.json'), '{"runs":[]}');

    const listed = await listRuns({ root: runRoot });
    assert.deepEqual(listed.map((entry) => entry.runId), [...ids].reverse(), 'newest first');
    assert.ok(listed.every((entry) => entry.error === null));
    assert.ok(listed.every((entry) => entry.state === RUNNING));

    // The only things in the root are the three run directories plus the two
    // decoys this test planted: the store keeps no index of its own, because an
    // index is a second thing that can disagree with the truth (ADR 0009 §2).
    assert.deepEqual(
      [...await readdir(runRoot)].sort(),
      [...ids, 'index.json', 'scratch'].sort(),
    );
  } finally {
    await removeTemporaryDirectory(root);
  }
});

test('an unreadable run is listed with its error rather than silently dropped', async () => {
  const root = await temporaryDirectory('pixelproof-run-list-broken-');
  try {
    const runRoot = path.join(root, 'runs');
    const good = await createRun({ root: runRoot, now: new Date('2026-08-13T09:00:00.000Z') });

    const future = path.join(runRoot, '2026-08-13T10-00-00Z-ffffffff');
    await mkdir(future, { recursive: true });
    await writeFile(path.join(future, 'run.json'), JSON.stringify({ schema: 'pixelproof.run/2', runId: path.basename(future) }));

    const corrupt = path.join(runRoot, '2026-08-13T11-00-00Z-eeeeeeee');
    await mkdir(corrupt, { recursive: true });
    await writeFile(path.join(corrupt, 'run.json'), '{ this is not json');

    const empty = path.join(runRoot, '2026-08-13T12-00-00Z-dddddddd');
    await mkdir(empty, { recursive: true });

    const listed = await listRuns({ root: runRoot });
    assert.equal(listed.length, 4);

    const byId = new Map(listed.map((entry) => [entry.runId, entry]));
    assert.equal(byId.get(good.runId).error, null);
    assert.equal(byId.get(path.basename(future)).error.code, 'RUN_SCHEMA_UNSUPPORTED');
    assert.equal(byId.get(path.basename(corrupt)).error.code, 'RUN_SCHEMA_UNSUPPORTED');
    assert.equal(byId.get(path.basename(empty)).error.code, 'RUN_NOT_FOUND');

    // An unreadable run is not an open run either — nothing may act on it.
    assert.deepEqual((await listOpenRuns({ root: runRoot })).map((entry) => entry.runId), [good.runId]);
  } finally {
    await removeTemporaryDirectory(root);
  }
});

// ---------------------------------------------------------------------------
// Envelope versioning
// ---------------------------------------------------------------------------

test('an unsupported envelope is refused, never parsed best-effort', async () => {
  const root = await temporaryDirectory('pixelproof-run-schema-');
  try {
    const runRoot = path.join(root, 'runs');
    const created = await createRun({ root: runRoot });
    const runFile = path.join(created.directory, 'run.json');
    const original = JSON.parse(await readFile(runFile, 'utf8'));

    for (const [schema, why] of [
      ['pixelproof.run/2', 'a newer major'],
      ['pixelproof.run/0', 'an older major'],
      ['pixelproof.report/1', 'a different envelope'],
      ['run', 'an unversioned string'],
      [undefined, 'no schema at all'],
    ]) {
      await writeFile(runFile, JSON.stringify({ ...original, schema }));
      await assert.rejects(
        readRun(created.directory),
        (error) => error instanceof RunError && error.code === 'RUN_SCHEMA_UNSUPPORTED',
        `${why} must be refused`,
      );
    }

    // A record that disagrees with the directory holding it cannot say which is
    // right, so it does not get to guess.
    await writeFile(runFile, JSON.stringify({ ...original, runId: '2026-01-01T00-00-00Z-aaaaaaaa' }));
    await assert.rejects(
      readRun(created.directory),
      (error) => error instanceof RunError && error.code === 'RUN_ID_MALFORMED',
    );

    // Unknown fields at a known major are tolerated and survive a write (ADR 0014 §4).
    await writeFile(runFile, JSON.stringify({ ...original, futureField: { added: 'by a newer build' } }));
    const read = await readRun(created.directory);
    assert.deepEqual(read.futureField, { added: 'by a newer build' });

    const afterWrite = await transitionRun(created.directory, PENDING_JUDGEMENT);
    assert.deepEqual(afterWrite.futureField, { added: 'by a newer build' }, 'an unknown field must not be dropped');
    assert.deepEqual((await readRun(created.directory)).futureField, { added: 'by a newer build' });
  } finally {
    await removeTemporaryDirectory(root);
  }
});

test('a missing run directory is RUN_NOT_FOUND, and a foreign one is refused', async () => {
  const root = await temporaryDirectory('pixelproof-run-missing-');
  try {
    await assert.rejects(
      readRun(path.join(root, 'runs', '2026-08-13T09-00-00Z-abcdef01')),
      (error) => error instanceof RunError && error.code === 'RUN_NOT_FOUND',
    );

    assert.throws(
      () => resolveRunDirectory({ runId: '2026-08-13T09-00-00Z-abcdef01/../../elsewhere', root }),
      (error) => error instanceof RunError && error.code === 'RUN_ID_MALFORMED',
    );

    const resolved = resolveRunDirectory({ runId: '2026-08-13T09-00-00Z-abcdef01', root });
    assert.equal(resolved.directory, path.join(root, '2026-08-13T09-00-00Z-abcdef01'));
  } finally {
    await removeTemporaryDirectory(root);
  }
});

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

test('every file a run writes is legal on Windows', async () => {
  const root = await temporaryDirectory('pixelproof-run-windows-');
  try {
    const created = await createRun({ root: path.join(root, 'runs'), command: 'generate' });
    const source = await writeArtifact(root, 'candidate.png', 'bytes');
    await recordAttempt(created.directory, { artifact: { path: source }, verification: verification() });
    await transitionRun(created.directory, PENDING_JUDGEMENT);
    await finaliseRun(created.directory, { state: ACCEPTED, acceptedAttempt: 1 });

    const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;
    const ILLEGAL = /[<>:"/\|?* -]/;

    const names = [created.runId, ...await readdir(created.directory)];
    for (const name of names) {
      assert.ok(!ILLEGAL.test(name), `"${name}" contains a character Windows forbids in a filename`);
      assert.ok(!RESERVED.test(name), `"${name}" is a reserved Windows device name`);
      assert.ok(!/[. ]$/.test(name), `"${name}" ends in a dot or space, which Windows silently strips`);
      assert.ok(name.length > 0 && name.length <= 100, `"${name}" is an unreasonable filename length`);
    }

    // Exactly the evidence the ADRs name, and no temp files left behind.
    assert.deepEqual(
      [...await readdir(created.directory)].sort(),
      ['attempt-1.json', 'attempt-1.png', 'report.json', 'report.md', 'run.json'],
    );
  } finally {
    await removeTemporaryDirectory(root);
  }
});
