import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { assignCheckIds } from '../core/contracts/check-id.mjs';
import {
  correctionsFor,
  foldCorrectionsIntoPrompt,
  renderCorrections,
} from '../core/generation/correction.mjs';
import {
  DEFAULT_RETAKES,
  MAX_ROUNDS,
  PendingError,
  applySubmission,
  assertRetakeable,
  boundOf,
  closePendingRun,
  hasRetakeLeft,
  issueFirstRound,
  lastRoundOf,
  listPendingRuns,
  listStalledRuns,
  nextAttemptNumber,
  openPendingRun,
  openRetakeableRun,
  parseSubmission,
  promoteArtifact,
  resolveRetakeBound,
  retakesLeft,
  roundInAttempt,
  selectClosableRun,
  verifySubmission,
} from '../core/judge/index.mjs';
import {
  ACCEPTED,
  PENDING_JUDGEMENT,
  REJECTED,
  RUNNING,
  createRun,
  finaliseRun,
  readRun,
  recordAttempt,
} from '../core/run/index.mjs';
import { removeTemporaryDirectory, temporaryDirectory, writePng } from './helpers/compat-harness.mjs';

/**
 * Retakes under a judged run (ADR 0020).
 *
 * The property every test here defends is the one the decision turns on: a
 * retake is a **new numbered attempt** inside the same run, and everything
 * attempt *n* recorded stays exactly where it was. A run that re-opened and then
 * quietly changed what a host had already judged would be the failure ADR 0009
 * §1 closed the `-> running` edge against in the first place.
 *
 * Nothing here spawns a process or needs `sharp`. The CLI end of the same
 * behaviour, through the real binary, is in `test/retake-cli.test.mjs`.
 */

const ASSERTIONS = [
  'The lamp is the only object in the frame.',
  'The background is a seamless white sweep with no visible horizon line.',
];

function verification({ ok = true, failed = 0, checks = [] } = {}) {
  return {
    file: 'attempt.png',
    decoder: 'none',
    degraded: true,
    passed: ok ? 2 : 1,
    failed,
    skipped: 0,
    strict: false,
    ok,
    checks,
    summary: { passed: ok ? 2 : 1, failed, skipped: 0 },
    warnings: [],
    notes: [],
  };
}

/** A judged run with an unspent bound, ready for its first attempt. */
async function judgedRun(root, { retakes = 1, out = null, judge = 'host' } = {}) {
  const runRoot = path.join(root, 'runs');
  const created = await createRun({
    root: runRoot,
    command: 'generate',
    resolved: {
      judge,
      provider: 'codex',
      prompt: 'A ceramic desk lamp on seamless white',
      retakes,
      out: out === null ? null : path.resolve(out),
    },
  });
  return { runRoot, directory: created.directory, runId: created.runId };
}

/** Record attempt `n` and issue its first round, continuing the round counter. */
async function attemptAndRound(fixture, attempt, { result = verification(), edge = 30 + attempt } = {}) {
  const artifact = path.join(fixture.directory, `attempt-${attempt}.png`);
  await writePng(artifact, edge, edge);

  const { run } = await recordAttempt(fixture.directory, {
    artifact: { path: artifact },
    verification: result,
    copy: false,
    number: attempt,
  });

  const entry = run.attempts.find((candidate) => candidate.number === attempt);
  const { record } = await issueFirstRound(fixture.directory, {
    run,
    checks: assignCheckIds(ASSERTIONS),
    artifactPath: entry.artifact.path,
    artifactSha256: entry.artifact.sha256,
    artifactBytes: entry.artifact.bytes,
    attempt,
    round: lastRoundOf(run) + 1,
    pixelproofVersion: '0.0.0-test',
  });

  return { record, run, artifact };
}

function submissionFor(record, verdicts, { evidence = 'what the host reported seeing' } = {}) {
  return parseSubmission({
    runId: record.runId,
    nonce: record.nonce,
    checksDigest: record.checksDigest,
    round: record.round,
    response: {
      protocol: 1,
      ok: true,
      judge: 'host',
      results: record.request.checks.map((check, index) => ({
        id: check.id,
        verdict: Array.isArray(verdicts) ? verdicts[index] : verdicts,
        evidence,
      })),
    },
  });
}

/** Submit against whatever round is currently open. */
async function submit(fixture, submission, { attempt = 1 } = {}) {
  const opened = await openPendingRun({ runId: fixture.runId, root: fixture.runRoot });
  const { response } = await verifySubmission({
    record: opened.record,
    round: opened.round,
    submission,
    directory: opened.directory,
  });
  return applySubmission(opened.directory, {
    run: opened.run,
    round: opened.round,
    record: opened.record,
    response,
    attempt,
    pixelproofVersion: '0.0.0-test',
  });
}

async function exists(directory, name) {
  return (await readdir(directory)).includes(name);
}

// --- the bound -------------------------------------------------------------

test('the bound is --retakes, then spec.retakes, then one — and only under --judge', () => {
  // The default is 1, not the 3 the example spec carries: honouring
  // `spec.retakes` unconditionally would triple what every existing caller with
  // a spec spends, which is a documented-semantic change ADR 0003 forbids.
  assert.equal(DEFAULT_RETAKES, 1);
  assert.equal(resolveRetakeBound({ judged: true }), 1);
  assert.equal(resolveRetakeBound({ judged: false }), 1);

  assert.equal(resolveRetakeBound({ spec: { retakes: 3 }, judged: true }), 3);
  assert.equal(resolveRetakeBound({ option: '5', spec: { retakes: 3 }, judged: true }), 5);
  assert.equal(resolveRetakeBound({ option: 2, judged: true }), 2);

  // The whole point of the gate: the same spec that means 3 under --judge means
  // one attempt without it, so a bare generate keeps costing exactly one call.
  assert.equal(resolveRetakeBound({ spec: { retakes: 3 }, judged: false }), 1);
  assert.throws(
    () => resolveRetakeBound({ option: '3', judged: false }),
    /--retakes only means something with --judge/,
  );
});

test('a bound that is not a whole number of attempts is refused, not rounded', () => {
  for (const value of ['0', 0, -1, '2.5', 'three', '', true, {}]) {
    assert.throws(
      () => resolveRetakeBound({ option: value, judged: true }),
      /must be a whole number of attempts/,
      `--retakes ${JSON.stringify(value)} must be refused`,
    );
  }

  // A malformed spec field is refused with its own name, so the message points
  // at the file rather than at a flag nobody typed.
  assert.throws(
    () => resolveRetakeBound({ spec: { retakes: '3 or so' }, judged: true }),
    /spec\.retakes must be a whole number/,
  );

  // And a spec that a bare generate accepts today keeps being accepted: the
  // field is only read on the judged path.
  assert.equal(resolveRetakeBound({ spec: { retakes: '3 or so' }, judged: false }), 1);
});

// --- corrections -----------------------------------------------------------

test('a correction is assembled from recorded evidence and never invented', () => {
  const corrections = correctionsFor({
    verification: {
      checks: [
        { name: 'width', expected: 1024, actual: 1024, passed: true, status: 'PASS' },
        { name: 'height', expected: 1024, actual: 768, passed: false, status: 'FAIL' },
        { name: 'alpha', expected: 'opaque', actual: 'no decoder', passed: null, status: 'SKIP' },
      ],
    },
    semantic: {
      checks: [
        { id: 's-aaaaaaaaaa', assertion: 'One lamp only.', verdict: 'pass', evidence: 'one lamp' },
        { id: 's-bbbbbbbbbb', assertion: 'No visible horizon.', verdict: 'fail', evidence: 'a grey seam at 60% height' },
        { id: 's-cccccccccc', assertion: 'The shade is linen.', verdict: 'unsure', evidence: null },
      ],
    },
  });

  // A passing check and a skipped check contribute nothing: telling a generator
  // to fix a check that passed, or one that never ran, would be inventing a
  // defect.
  assert.deepEqual(corrections.mechanical, [
    { name: 'height', expected: '1024', actual: '768' },
  ]);
  assert.equal(corrections.semantic.length, 2);
  assert.deepEqual(corrections.semantic.map((check) => check.verdict), ['fail', 'unsure']);

  const block = renderCorrections(corrections, { attempt: 1 });
  assert.match(block, /Corrections from attempt 1/);
  assert.match(block, /expected 1024, got 768/);
  // The judge's own words, verbatim — not a summary of them.
  assert.match(block, /The judge reported: a grey seam at 60% height/);
  // No evidence means it says so, rather than inventing a reason.
  assert.match(block, /The judge recorded no evidence for that verdict\./);
  assert.doesNotMatch(block, /One lamp only/, 'a passing assertion is not a correction');
  assert.doesNotMatch(block, /alpha/, 'a skipped check is not a failed one');
});

test('an attempt with nothing wrong appends no corrections block', () => {
  const nothing = correctionsFor({ verification: { checks: [] }, semantic: null });
  assert.equal(renderCorrections(nothing, { attempt: 1 }), '');
  assert.equal(foldCorrectionsIntoPrompt('a lamp', nothing, { attempt: 1 }), 'a lamp');

  const something = correctionsFor({
    verification: { checks: [{ name: 'width', expected: 8, actual: 9, passed: false }] },
  });
  const folded = foldCorrectionsIntoPrompt('a lamp', something, { attempt: 1 });
  assert.ok(folded.startsWith('a lamp'), 'the corrections go after the prompt, never over it');
  assert.match(folded, /expected 8, got 9/);
});

// --- what submit does with an unspent bound --------------------------------

test('a rejected attempt with the bound unspent leaves the run open, not finalised', async () => {
  const root = await temporaryDirectory('pixelproof-retake-open-');
  try {
    const out = path.join(root, 'delivered', 'hero.png');
    const fixture = await judgedRun(root, { retakes: 3, out });
    const { record } = await attemptAndRound(fixture, 1);

    const applied = await submit(fixture, submissionFor(record, ['pass', 'fail'], {
      evidence: 'a grey seam runs across the lower third',
    }));

    assert.equal(applied.outcome, 'retakeable');
    assert.equal(applied.run.state, RUNNING);
    assert.equal(applied.run.accepted, null, 'the run has not decided, so accepted stays null');
    assert.equal(applied.run.outcome, null, 'a run that is still open has no outcome');
    assert.equal(applied.attempt, 2);

    // Nothing was promoted and no report was written: the run is not finished.
    assert.equal(await exists(fixture.directory, 'report.json'), false);
    await assert.rejects(() => readFile(out), { code: 'ENOENT' },
      'a rejected attempt promotes nothing, whether or not another one is coming');

    // The verdicts are durable before the state ever moves, which is what makes
    // an abandon at this point safe.
    const attempt = JSON.parse(await readFile(path.join(fixture.directory, 'attempt-1.json'), 'utf8'));
    assert.equal(attempt.semantic.checks.length, ASSERTIONS.length);
    assert.equal(attempt.semantic.checks[1].verdict, 'fail');
    assert.equal(applied.run.judge.checks.length, ASSERTIONS.length);
    assert.equal(await exists(fixture.directory, 'judge-result-1.json'), true);

    // The reason names what happened and what to do about it.
    const reasons = applied.run.reasons.map((reason) => reason.code);
    assert.ok(reasons.includes('retake-available'), reasons.join(', '));
    assert.match(
      applied.run.reasons.at(-1).message,
      /2 attempts left of 3 — pixelproof retake --run /,
    );
  } finally {
    await removeTemporaryDirectory(root);
  }
});

test('a rejected attempt on the default bound of one still finalises exactly as before', async () => {
  const root = await temporaryDirectory('pixelproof-retake-default-');
  try {
    const fixture = await judgedRun(root);
    const { record } = await attemptAndRound(fixture, 1);

    const applied = await submit(fixture, submissionFor(record, 'fail'));

    assert.equal(applied.outcome, 'rejected');
    assert.equal(applied.reason, 'semantic-failed', 'a run that asked for no retake is not "exhausted"');
    assert.equal(applied.run.state, REJECTED);
    assert.equal(await exists(fixture.directory, 'report.json'), true);
  } finally {
    await removeTemporaryDirectory(root);
  }
});

test('the last attempt of a spent bound finalises rejected and promotes nothing', async () => {
  const root = await temporaryDirectory('pixelproof-retake-exhausted-');
  try {
    const out = path.join(root, 'delivered', 'hero.png');
    const fixture = await judgedRun(root, { retakes: 2, out });

    const first = await attemptAndRound(fixture, 1);
    const opened = await submit(fixture, submissionFor(first.record, 'fail'));
    assert.equal(opened.outcome, 'retakeable');

    const second = await attemptAndRound(fixture, 2);
    const applied = await submit(fixture, submissionFor(second.record, 'fail'), { attempt: 2 });

    assert.equal(applied.outcome, 'rejected');
    assert.equal(applied.reason, 'retakes-exhausted');
    assert.equal(applied.run.state, REJECTED);
    assert.equal(applied.run.outcome.acceptedAttempt, null);
    assert.match(applied.run.reasons.at(-1).message, /the retake bound of 2 is spent/);

    // ADR 0020 §7: nothing is promoted on exhaustion. There is no ranking
    // function to appeal to, and "best" would silently mean "last".
    await assert.rejects(() => readFile(out), { code: 'ENOENT' });

    // Both attempts are in the report, so an operator can choose one by hand.
    const report = JSON.parse(await readFile(path.join(fixture.directory, 'report.json'), 'utf8'));
    assert.deepEqual(report.attempts.map((entry) => entry.number), [1, 2]);
  } finally {
    await removeTemporaryDirectory(root);
  }
});

// --- the second attempt ----------------------------------------------------

test('a retake is a new attempt in the same run, and attempt 1 is untouched', async () => {
  const root = await temporaryDirectory('pixelproof-retake-second-');
  try {
    const out = path.join(root, 'delivered', 'hero.png');
    const fixture = await judgedRun(root, { retakes: 2, out });

    const first = await attemptAndRound(fixture, 1);
    const firstBytes = await readFile(first.artifact);
    await submit(fixture, submissionFor(first.record, 'fail'));

    const opened = await openRetakeableRun({ runId: fixture.runId, root: fixture.runRoot });
    assert.equal(opened.attempt, 2, 'the next attempt is the next number, never a re-run of the last');

    const second = await attemptAndRound(fixture, 2);

    // Round numbers continue across attempts, so the request filenames stay
    // unique inside one directory (ADR 0020 §5).
    assert.equal(second.record.round, 2);
    assert.equal(second.record.attempt, 2);
    assert.equal(second.record.roundInAttempt, 1);
    assert.equal(await exists(fixture.directory, 'judge-request-1.json'), true);
    assert.equal(await exists(fixture.directory, 'judge-request-2.json'), true);

    const pending = await readRun(opened.directory);
    assert.equal(pending.state, PENDING_JUDGEMENT);
    assert.deepEqual(pending.rounds.map((entry) => [entry.round, entry.attempt]), [[1, 1], [2, 2]]);
    assert.equal(pending.judge.attempt, 2);
    assert.deepEqual(pending.judge.checks, [],
      'attempt 2 is judged on its own bytes; carrying attempt 1 verdicts forward would decide a run on a file that is no longer the subject');

    const applied = await submit(fixture, submissionFor(second.record, 'pass'), { attempt: 2 });
    assert.equal(applied.outcome, 'accepted');
    assert.equal(applied.run.outcome.acceptedAttempt, 2);

    const promoted = await promoteArtifact(fixture.directory, { run: applied.run, attempt: 2 });
    assert.deepEqual(await readFile(promoted), await readFile(second.artifact));
    assert.notDeepEqual(await readFile(promoted), firstBytes, 'the accepted bytes are attempt 2, not attempt 1');

    // Attempt 1's record still describes attempt 1: same bytes, same verdicts.
    assert.deepEqual(await readFile(first.artifact), firstBytes);
    const attemptOne = JSON.parse(await readFile(path.join(fixture.directory, 'attempt-1.json'), 'utf8'));
    assert.equal(attemptOne.semantic.checks[0].verdict, 'fail');
    assert.equal(attemptOne.artifact.sha256, applied.run.attempts[0].artifact.sha256);
  } finally {
    await removeTemporaryDirectory(root);
  }
});

test('each attempt gets its own escalation, and still no third round within it', async () => {
  const root = await temporaryDirectory('pixelproof-retake-escalation-');
  try {
    const fixture = await judgedRun(root, { retakes: 2 });

    const first = await attemptAndRound(fixture, 1);
    await submit(fixture, submissionFor(first.record, 'fail'));

    const second = await attemptAndRound(fixture, 2);
    assert.equal(second.record.round, 2, 'attempt 2 starts at the next run-wide round');

    // Run round 2 is attempt 2's *first* round, so it is entitled to the one
    // escalation ADR 0009 §5 grants an attempt. Deciding on the run-wide number
    // would silently deny it.
    const escalated = await submit(fixture, submissionFor(second.record, 'unsure'), { attempt: 2 });
    assert.equal(escalated.outcome, 'escalated');
    assert.equal(escalated.record.round, 3);
    assert.equal(escalated.record.attempt, 2);
    assert.equal(escalated.record.roundInAttempt, MAX_ROUNDS);
    assert.equal(escalated.record.escalationTerminal, true);
    assert.equal(escalated.record.onUnsure, 'fail');

    const run = await readRun(fixture.directory);
    assert.equal(roundInAttempt(run, 1), 1);
    assert.equal(roundInAttempt(run, 2), 1, 'run round 2 is attempt 2 round 1');
    assert.equal(roundInAttempt(run, 3), 2, 'run round 3 is attempt 2 round 2');

    // And the bound still bites: a second unsure terminates in fail, not in a
    // round 4.
    const done = await submit(fixture, submissionFor(escalated.record, 'unsure'), { attempt: 2 });
    assert.equal(done.outcome, 'rejected');
    assert.equal(await exists(fixture.directory, 'judge-request-4.json'), false);
  } finally {
    await removeTemporaryDirectory(root);
  }
});

test('re-opening a run does not make an old nonce replayable', async () => {
  // ADR 0009's nonce is single-use because finalisation moves the run off
  // `pending-judgement`. A run that can go back there is the one thing that
  // could have weakened it, so this is the test that says it did not.
  const root = await temporaryDirectory('pixelproof-retake-replay-');
  try {
    const fixture = await judgedRun(root, { retakes: 3 });
    const first = await attemptAndRound(fixture, 1);
    const stale = submissionFor(first.record, 'pass');

    await submit(fixture, submissionFor(first.record, 'fail'));

    // While the run sits between attempts there is no open round at all.
    await assert.rejects(
      () => openPendingRun({ runId: fixture.runId, root: fixture.runRoot }),
      (error) => error instanceof PendingError && error.code === 'PENDING_NOT_OPEN',
    );

    // And once it is pending again, the old nonce answers a round that is no
    // longer open — refused on the round first, and on the nonce if the round is
    // omitted.
    const second = await attemptAndRound(fixture, 2);
    await assert.rejects(
      () => submit(fixture, stale, { attempt: 2 }),
      (error) => error instanceof PendingError && error.code === 'PENDING_NOT_OPEN',
    );

    const withoutRound = parseSubmission({ ...stale, round: null });
    await assert.rejects(
      () => submit(fixture, withoutRound, { attempt: 2 }),
      (error) => error instanceof PendingError && error.code === 'PENDING_NONCE_MISMATCH',
    );

    // The discriminating half: the same payload with attempt 2's own nonce is
    // accepted, so the refusals above are the nonce doing its job and not the
    // submission being malformed some other way.
    const fresh = await submit(fixture, submissionFor(second.record, 'pass'), { attempt: 2 });
    assert.equal(fresh.outcome, 'accepted');
    assert.equal(fresh.run.state, ACCEPTED);
  } finally {
    await removeTemporaryDirectory(root);
  }
});

// --- the refusals ----------------------------------------------------------

test('retake refuses a run that must not be retaken, with a named reason', async () => {
  const root = await temporaryDirectory('pixelproof-retake-refusals-');
  try {
    const refusal = async (fixture, code) => {
      await assert.rejects(
        () => openRetakeableRun({ runId: fixture.runId, root: fixture.runRoot }),
        (error) => {
          assert.ok(error instanceof PendingError, `expected a PendingError, got ${error}`);
          assert.equal(error.code, code, error.message);
          return true;
        },
      );
    };

    // Nothing recorded yet: there is nothing to correct.
    const empty = await judgedRun(root, { retakes: 3 });
    await refusal(empty, 'RETAKE_NOT_OPEN');

    // An outstanding judgement: answer or abandon it first.
    const pending = await judgedRun(root, { retakes: 3 });
    await attemptAndRound(pending, 1);
    await refusal(pending, 'RETAKE_NOT_OPEN');

    // Terminal.
    const closed = await judgedRun(root, { retakes: 3 });
    const closedRound = await attemptAndRound(closed, 1);
    await submit(closed, submissionFor(closedRound.record, 'pass'));
    await refusal(closed, 'RETAKE_NOT_OPEN');

    // The bound is spent, on a run that is otherwise perfectly open.
    const spent = await judgedRun(root, { retakes: 1 });
    await recordAttempt(spent.directory, {
      artifact: null,
      verification: verification({ ok: false, failed: 1 }),
      number: 1,
    });
    const spentRun = await readRun(spent.directory);
    assert.equal(spentRun.state, RUNNING);
    // ... but with a judge recorded, so the refusal is about the bound and not
    // about the absent handoff.
    assert.throws(
      () => assertRetakeable({ ...spentRun, judge: { kind: 'host' } }, { runId: spent.runId }),
      (error) => error instanceof PendingError && error.code === 'RETAKE_EXHAUSTED',
    );
    // Without the judge, the same run is refused for the other reason — which is
    // what shows the two codes are discriminating rather than interchangeable.
    assert.throws(
      () => assertRetakeable(spentRun, { runId: spent.runId }),
      (error) => error instanceof PendingError && error.code === 'RETAKE_NOT_OPEN',
    );

    // A malformed id never becomes a path (ADR 0009 §3), reusing the existing
    // refusal rather than minting a RETAKE_ spelling for a failure that is not new.
    await assert.rejects(
      () => openRetakeableRun({ runId: '../../etc', root: path.join(root, 'runs') }),
      (error) => error instanceof PendingError && error.code === 'PENDING_ID_MALFORMED',
    );
  } finally {
    await removeTemporaryDirectory(root);
  }
});

test('the bound is counted from recorded attempts, not from a separate tally', async () => {
  const root = await temporaryDirectory('pixelproof-retake-counting-');
  try {
    const fixture = await judgedRun(root, { retakes: 2 });
    let run = await readRun(fixture.directory);

    assert.equal(boundOf(run), 2);
    assert.equal(retakesLeft(run), 2);
    assert.equal(nextAttemptNumber(run), 1);
    assert.equal(hasRetakeLeft(run), true);

    await attemptAndRound(fixture, 1);
    run = await readRun(fixture.directory);
    assert.equal(retakesLeft(run), 1);
    assert.equal(nextAttemptNumber(run), 2);

    await submit(fixture, submissionFor((await attemptAndRound(fixture, 2)).record, 'fail'), { attempt: 2 });
    run = await readRun(fixture.directory);
    assert.equal(retakesLeft(run), 0);
    assert.equal(hasRetakeLeft(run), false);

    // A run that recorded no bound is one attempt, not unbounded.
    assert.equal(boundOf({ resolved: {} }), 1);
    assert.equal(boundOf({}), 1);
  } finally {
    await removeTemporaryDirectory(root);
  }
});

// --- abandoning a run between attempts -------------------------------------

test('abandon reaches a run left open between attempts, and discards no verdict', async () => {
  const root = await temporaryDirectory('pixelproof-retake-abandon-');
  try {
    const fixture = await judgedRun(root, { retakes: 3 });
    const { record } = await attemptAndRound(fixture, 1);
    await submit(fixture, submissionFor(record, ['pass', 'fail'], { evidence: 'a grey seam at 60% height' }));

    // Not pending: nothing is outstanding, so `judge pending` correctly cannot
    // see it and `submit`'s selector correctly refuses it.
    assert.deepEqual(await listPendingRuns({ root: fixture.runRoot }), []);
    const stalled = await listStalledRuns({ root: fixture.runRoot });
    assert.deepEqual(stalled.map((entry) => entry.runId), [fixture.runId]);

    const closable = await selectClosableRun({ root: fixture.runRoot });
    assert.equal(closable.runId, fixture.runId);
    assert.equal(closable.round, null, 'a run between attempts has no unanswered round');

    await closePendingRun(closable.directory, { message: 'the brief changed' });

    const closed = await readRun(fixture.directory);
    assert.equal(closed.state, REJECTED);
    assert.equal(closed.accepted, false);

    // Nothing submitted was lost. The verdicts were written before the run ever
    // left `pending-judgement`, so an abandon here cannot discard one.
    const attempt = JSON.parse(await readFile(path.join(fixture.directory, 'attempt-1.json'), 'utf8'));
    assert.equal(attempt.semantic.checks[1].verdict, 'fail');
    assert.equal(attempt.semantic.checks[1].evidence, 'a grey seam at 60% height');
    assert.equal(closed.judge.checks.length, ASSERTIONS.length);
    assert.equal(await exists(fixture.directory, 'judge-result-1.json'), true);

    const report = JSON.parse(await readFile(path.join(fixture.directory, 'report.json'), 'utf8'));
    assert.deepEqual(report.attempts.map((entry) => entry.number), [1]);
    assert.ok(report.reasons.some((reason) => reason.code === 'retake-available'));
    assert.ok(report.reasons.some((reason) => reason.code === 'judgement-abandoned'));
  } finally {
    await removeTemporaryDirectory(root);
  }
});

test('abandon still refuses a closed run, and still says an unanswered round was never answered', async () => {
  const root = await temporaryDirectory('pixelproof-retake-abandon-closed-');
  try {
    // A run with an outstanding checklist is closable — that is ADR 0009 §4 —
    // and the round it never answered is reported rather than glossed over.
    const pending = await judgedRun(root, { retakes: 2 });
    await attemptAndRound(pending, 1);
    const open = await selectClosableRun({ runId: pending.runId, root: pending.runRoot });
    assert.equal(open.round.round, 1);
    assert.equal(open.round.submittedAt, null);

    // A terminal run is refused: it is already on the record.
    const closed = await judgedRun(root, { retakes: 2 });
    await recordAttempt(closed.directory, { artifact: null, verification: verification(), number: 1 });
    await finaliseRun(closed.directory, { state: REJECTED, reason: 'mechanical-failed' });
    await assert.rejects(
      () => selectClosableRun({ runId: closed.runId, root: closed.runRoot }),
      (error) => error instanceof PendingError && error.code === 'PENDING_NOT_OPEN',
    );
  } finally {
    await removeTemporaryDirectory(root);
  }
});
