/**
 * The host judge handoff, at the core layer (ADR 0009).
 *
 * These tests are aimed at the two properties the ADR calls load-bearing, and
 * each one is written so that removing the mechanism makes it fail rather than
 * merely changing a message:
 *
 * 1. **Identity is proven, not inferred.** The nonce tests submit content that
 *    is byte-for-byte correct and still get refused, which no amount of digest
 *    checking would catch — that is the whole point of ADR 0009 §3.
 * 2. **A missing verdict is never a pass.** Every refusal path is asserted to
 *    leave the run un-accepted, and the promotion tests assert the *absence* of
 *    a file at `--out` as well as its later presence.
 */

import assert from 'node:assert/strict';
import { access, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { assignCheckIds } from '../core/contracts/check-id.mjs';
import { RUN_ERROR_CODES, RunError } from '../core/run/errors.mjs';
import { createRun, readRun, readReport, recordAttempt } from '../core/run/index.mjs';
import {
  JUDGE_PENDING_SCHEMA,
  JUDGE_RESULT_SCHEMA,
  MAX_ROUNDS,
  PENDING_REASONS,
  PendingError,
  applySubmission,
  asPendingError,
  checksDigestFor,
  closePendingRun,
  isNonce,
  issueFirstRound,
  listPendingRuns,
  newNonce,
  nonceMatches,
  openPendingRun,
  parseDeadline,
  parseSubmission,
  pendingRequestFor,
  promoteArtifact,
  selectPendingRun,
  sha256OfFile,
  verifySubmission,
} from '../core/judge/index.mjs';
import { removeTemporaryDirectory, temporaryDirectory, writePng } from './helpers/compat-harness.mjs';

const ASSERTIONS = [
  'Zero text, letters, numbers, watermarks or signage anywhere in the frame',
  'No people or hands appear anywhere',
];

/** A run directory holding one verified attempt and one open round 1. */
async function pendingFixture(root, { assertions = ASSERTIONS, deadlineMs, now, out = null } = {}) {
  const runRoot = path.join(root, 'runs');
  const created = await createRun({
    root: runRoot,
    command: 'generate',
    resolved: { judge: 'host', out: out === null ? null : path.resolve(out) },
    now,
  });

  const artifact = path.join(created.directory, 'attempt-1.png');
  await writePng(artifact, 32, 32);

  const { run } = await recordAttempt(created.directory, {
    artifact: { path: artifact },
    verification: { ok: true, passed: 2, failed: 0, skipped: 0, strict: false },
    copy: false,
    now,
  });

  const attemptRecord = run.attempts[0];
  const { record } = await issueFirstRound(created.directory, {
    run,
    checks: assignCheckIds(assertions),
    artifactPath: attemptRecord.artifact.path,
    artifactSha256: attemptRecord.artifact.sha256,
    artifactBytes: attemptRecord.artifact.bytes,
    deadlineMs,
    pixelproofVersion: '0.0.0-test',
    now,
  });

  return { runRoot, directory: created.directory, runId: created.runId, record, artifact };
}

/** A well-formed submission for every check in a record, all one verdict. */
function submissionFor(record, verdicts) {
  return parseSubmission({
    runId: record.runId,
    nonce: record.nonce,
    checksDigest: record.checksDigest,
    response: {
      protocol: 1,
      ok: true,
      judge: 'host',
      results: record.request.checks.map((check, index) => ({
        id: check.id,
        verdict: Array.isArray(verdicts) ? verdicts[index] : verdicts,
        evidence: 'what the host reported seeing',
      })),
    },
  });
}

async function submit(fixture, submission, { now } = {}) {
  const opened = await openPendingRun({ runId: fixture.runId, root: fixture.runRoot });
  const { response } = await verifySubmission({
    record: opened.record,
    round: opened.round,
    submission,
    directory: opened.directory,
    now,
  });
  return applySubmission(opened.directory, {
    run: opened.run,
    round: opened.round,
    record: opened.record,
    response,
    attempt: 1,
    now,
  });
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

// --- digests and the nonce ------------------------------------------------

test('checksDigest identifies the assertions, not their order', () => {
  const checks = assignCheckIds(ASSERTIONS);
  const reversed = [...checks].reverse();

  assert.equal(checksDigestFor(checks), checksDigestFor(reversed),
    'sorting by id is what makes a reordered spec the same checklist (ADR 0010)');

  const reworded = assignCheckIds([ASSERTIONS[0], 'No people, hands or limbs appear anywhere']);
  assert.notEqual(checksDigestFor(checks), checksDigestFor(reworded),
    'a reworded assertion is a different assertion and must move the digest');
});

test('a nonce is 32 random bytes and is compared as a secret', () => {
  const first = newNonce();
  const second = newNonce();

  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(Buffer.from(first, 'hex').length, 32, 'ADR 0009 §3 specifies 32 bytes');
  assert.notEqual(first, second, 'two records must not share an identity');

  assert.equal(nonceMatches(first, first), true);
  assert.equal(nonceMatches(first, second), false);
  // Malformed input must return false rather than throw out of timingSafeEqual.
  assert.equal(nonceMatches('short', first), false);
  assert.equal(nonceMatches(undefined, first), false);
  assert.equal(isNonce('Z'.repeat(64)), false);
});

test('--judge-deadline refuses a bare number rather than guessing its unit', () => {
  assert.equal(parseDeadline('24h'), 86_400_000);
  assert.equal(parseDeadline('90m'), 5_400_000);
  assert.equal(parseDeadline('45s'), 45_000);
  assert.equal(parseDeadline('7d'), 604_800_000);

  // Seconds and milliseconds are a thousandfold apart, and this tool already
  // carries PIXELPROOF_TIMEOUT_MS in milliseconds. Guessing wrong expires a run
  // nobody had a chance to answer.
  assert.throws(() => parseDeadline('3600'), /whole number followed by s, m, h or d/);
  assert.throws(() => parseDeadline('0h'), /greater than zero/);
  assert.throws(() => parseDeadline('400d'), /at most 365d/);
  assert.throws(() => parseDeadline(''), /requires a duration/);
});

// --- the pending record ---------------------------------------------------

test('the pending record wraps the protocol without extending it', async () => {
  const root = await temporaryDirectory('pixelproof-judge-envelope-');
  try {
    const fixture = await pendingFixture(root);
    const { record, directory } = fixture;

    assert.equal(record.schema, JUDGE_PENDING_SCHEMA);
    assert.equal(record.protocol, 1);
    assert.equal(record.maxRounds, MAX_ROUNDS);

    // The request block is exactly the protocol's shape; nothing was bolted on.
    assert.deepEqual(Object.keys(record.request).sort(), ['checks', 'context', 'file', 'protocol']);
    for (const check of record.request.checks) {
      assert.deepEqual(Object.keys(check).sort(), ['assertion', 'id']);
    }

    // Paths inside the record stay relative so an archived run directory is
    // still readable (ADR 0014 §2) ...
    assert.equal(record.artifact.path, 'attempt-1.png');
    assert.equal(record.request.file, 'attempt-1.png');
    // ... and are resolved on the way out, because a judge process cannot open
    // a path relative to a directory it was never told about.
    assert.equal(
      pendingRequestFor(record, directory).file,
      path.resolve(directory, 'attempt-1.png'),
    );

    assert.equal(record.artifact.sha256, await sha256OfFile(fixture.artifact));
    assert.equal(record.checksDigest, checksDigestFor(record.request.checks));
  } finally {
    await removeTemporaryDirectory(root);
  }
});

test('a pending run says accepted: false out loud and promotes nothing', async () => {
  const root = await temporaryDirectory('pixelproof-judge-pending-');
  try {
    const out = path.join(root, 'delivered', 'hero.png');
    const fixture = await pendingFixture(root, { out });
    const run = await readRun(fixture.directory);

    assert.equal(run.state, 'pending-judgement');
    assert.equal(run.accepted, false, 'ADR 0009 §4 wants this explicit, not null');
    assert.equal(run.outcome, null);
    assert.ok(run.reasons.some((reason) => reason.code === 'awaiting-host-judgement'));

    // The whole promotion rule in one assertion: nothing is at --out yet.
    assert.equal(await exists(out), false,
      'under --judge the artifact appears at --out only on acceptance (ADR 0009 §2)');

    const listed = await listPendingRuns({ root: fixture.runRoot });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].runId, fixture.runId);
    assert.equal(listed[0].error, null);
  } finally {
    await removeTemporaryDirectory(root);
  }
});

test('--run may be omitted only while exactly one run is pending', async () => {
  const root = await temporaryDirectory('pixelproof-judge-select-');
  try {
    const first = await pendingFixture(root);
    const selected = await selectPendingRun({ root: first.runRoot });
    assert.equal(selected.runId, first.runId);

    await pendingFixture(root);
    await assert.rejects(
      () => selectPendingRun({ root: first.runRoot }),
      (error) => error instanceof PendingError
        && error.code === 'PENDING_NOT_OPEN'
        && error.details.candidates.length === 2,
      'a run that cannot prove which pending record is its own does not get to guess',
    );
  } finally {
    await removeTemporaryDirectory(root);
  }
});

// --- the nine refusals ----------------------------------------------------

test('a malformed --run is refused before any path is built from it', async () => {
  const root = await temporaryDirectory('pixelproof-judge-traversal-');
  try {
    const runRoot = path.join(root, 'runs');
    for (const runId of ['../../etc', '..', 'not-a-run-id', '2026-08-13T09:21:04Z-a3f9c1d2']) {
      await assert.rejects(
        () => openPendingRun({ runId, root: runRoot }),
        (error) => error instanceof PendingError && error.code === 'PENDING_ID_MALFORMED',
        `${runId} must be refused rather than followed`,
      );
    }
  } finally {
    await removeTemporaryDirectory(root);
  }
});

test('every run-store failure has a name in the handoff vocabulary', () => {
  // ADR 0014 §6: two vocabularies, one mechanism. A store code with no mapping
  // would surface as an unhandled crash instead of a named refusal.
  const mapped = RUN_ERROR_CODES.map((code) => {
    const translated = asPendingError(new RunError(code, `synthetic ${code}`));
    assert.ok(translated instanceof PendingError);
    assert.ok(PENDING_REASONS.includes(translated.code), `${code} maps outside the closed set`);
    assert.equal(translated.cause.code, code, 'the original must survive as the cause');
    return translated.code;
  });

  assert.equal(mapped.length, RUN_ERROR_CODES.length);
  assert.ok(mapped.includes('PENDING_FOREIGN_ROOT'));
  // Anything that is not a store failure is rethrown untouched: an EACCES is
  // not a refused submission.
  assert.throws(() => asPendingError(new TypeError('disk on fire')), TypeError);
});

test('a run that is not pending has no round to answer', async () => {
  const root = await temporaryDirectory('pixelproof-judge-notopen-');
  try {
    const runRoot = path.join(root, 'runs');
    const created = await createRun({ root: runRoot, command: 'generate' });

    await assert.rejects(
      () => openPendingRun({ runId: created.runId, root: runRoot }),
      (error) => error.code === 'PENDING_NOT_OPEN' && /running/.test(error.message),
    );
    await assert.rejects(
      () => openPendingRun({ runId: '2026-08-13T09-21-04Z-deadbeef', root: runRoot }),
      (error) => error.code === 'PENDING_NOT_FOUND',
    );
  } finally {
    await removeTemporaryDirectory(root);
  }
});

test('an unsupported pending envelope is refused, never parsed best-effort', async () => {
  const root = await temporaryDirectory('pixelproof-judge-schema-');
  try {
    const fixture = await pendingFixture(root);
    const file = path.join(fixture.directory, 'judge-request-1.json');
    const document = JSON.parse(await readFile(file, 'utf8'));

    await writeFile(file, JSON.stringify({ ...document, schema: 'pixelproof.judge-pending/2' }));
    await assert.rejects(
      () => openPendingRun({ runId: fixture.runId, root: fixture.runRoot }),
      (error) => error.code === 'PENDING_SCHEMA_UNSUPPORTED',
    );

    await writeFile(file, JSON.stringify({ ...document, protocol: 99 }));
    await assert.rejects(
      () => openPendingRun({ runId: fixture.runId, root: fixture.runRoot }),
      (error) => error.code === 'PENDING_SCHEMA_UNSUPPORTED',
    );
  } finally {
    await removeTemporaryDirectory(root);
  }
});

test('content that is correct in every respect but the nonce is still refused', async () => {
  const root = await temporaryDirectory('pixelproof-judge-nonce-');
  try {
    const fixture = await pendingFixture(root);
    const opened = await openPendingRun({ runId: fixture.runId, root: fixture.runRoot });

    // This is the case digests cannot catch: identical spec, identical bytes,
    // identical verdicts — a second concurrent run of the same spec computes
    // exactly these digests. Only the nonce can say whose run this is.
    const foreign = submissionFor(fixture.record, 'pass');
    foreign.nonce = newNonce();

    await assert.rejects(
      () => verifySubmission({
        record: opened.record, round: opened.round, submission: foreign, directory: opened.directory,
      }),
      (error) => error.code === 'PENDING_NONCE_MISMATCH',
    );

    const anonymous = submissionFor(fixture.record, 'pass');
    anonymous.nonce = null;
    await assert.rejects(
      () => verifySubmission({
        record: opened.record, round: opened.round, submission: anonymous, directory: opened.directory,
      }),
      (error) => error.code === 'PENDING_NONCE_MISMATCH',
      'an absent nonce is a mismatch, not a waiver',
    );

    assert.equal((await readRun(fixture.directory)).accepted, false);

    // The discriminating half: the *same* payload, with only `nonce` restored,
    // goes straight through. Nothing else about the submission changed, so the
    // three refusals above can only be attributable to the nonce check — which
    // is the property a digest-only design could never have.
    foreign.nonce = fixture.record.nonce;
    const { response } = await verifySubmission({
      record: opened.record, round: opened.round, submission: foreign, directory: opened.directory,
    });
    assert.equal(response.ok, true);
    assert.equal(response.results.length, ASSERTIONS.length);
  } finally {
    await removeTemporaryDirectory(root);
  }
});

test('a moved spec, an expired deadline, and changed bytes are each named', async () => {
  const root = await temporaryDirectory('pixelproof-judge-content-');
  try {
    const fixture = await pendingFixture(root);
    const opened = await openPendingRun({ runId: fixture.runId, root: fixture.runRoot });

    const moved = submissionFor(fixture.record, 'pass');
    moved.checksDigest = 'a'.repeat(64);
    await assert.rejects(
      () => verifySubmission({
        record: opened.record, round: opened.round, submission: moved, directory: opened.directory,
      }),
      (error) => error.code === 'PENDING_CHECKS_MISMATCH',
    );

    const wrongRun = submissionFor(fixture.record, 'pass');
    wrongRun.runId = '2026-01-01T00-00-00Z-00000000';
    await assert.rejects(
      () => verifySubmission({
        record: opened.record, round: opened.round, submission: wrongRun, directory: opened.directory,
      }),
      (error) => error.code === 'PENDING_ID_MALFORMED',
    );

    const late = new Date(new Date(fixture.record.expiresAt).getTime() + 1_000);
    await assert.rejects(
      () => verifySubmission({
        record: opened.record,
        round: opened.round,
        submission: submissionFor(fixture.record, 'pass'),
        directory: opened.directory,
        now: late,
      }),
      (error) => error.code === 'PENDING_EXPIRED',
    );

    await writePng(fixture.artifact, 48, 48);
    await assert.rejects(
      () => verifySubmission({
        record: opened.record,
        round: opened.round,
        submission: submissionFor(fixture.record, 'pass'),
        directory: opened.directory,
      }),
      (error) => error.code === 'ARTIFACT_CHANGED',
      'verdicts must never describe bytes that no longer exist',
    );
  } finally {
    await removeTemporaryDirectory(root);
  }
});

test('an expired judgement closes the run as rejected, with a report', async () => {
  const root = await temporaryDirectory('pixelproof-judge-expiry-');
  try {
    const fixture = await pendingFixture(root, { deadlineMs: 1_000 });
    await closePendingRun(fixture.directory, { message: 'deadline passed' });

    const run = await readRun(fixture.directory);
    assert.equal(run.state, 'rejected');
    assert.equal(run.accepted, false);
    assert.equal(run.outcome.reason, 'judgement-abandoned');

    const report = await readReport(fixture.directory);
    assert.equal(report.accepted, false);
    // The rejected candidate is still on disk: expiry is a verdict about the
    // process, never about the artifact.
    assert.equal(await exists(fixture.artifact), true);
  } finally {
    await removeTemporaryDirectory(root);
  }
});

// --- verdicts, escalation, acceptance -------------------------------------

test('a passing submission accepts the run and promotes the artifact', async () => {
  const root = await temporaryDirectory('pixelproof-judge-accept-');
  try {
    const out = path.join(root, 'delivered', 'hero.png');
    const fixture = await pendingFixture(root, { out });

    assert.equal(await exists(out), false, 'nothing before acceptance');

    const applied = await submit(fixture, submissionFor(fixture.record, 'pass'));
    assert.equal(applied.outcome, 'accepted');
    assert.equal(applied.run.accepted, true);
    assert.equal(applied.run.outcome.acceptedAttempt, 1);

    const promoted = await promoteArtifact(fixture.directory, { run: applied.run, attempt: 1 });
    assert.equal(promoted, path.resolve(out));
    assert.deepEqual(await readFile(out), await readFile(fixture.artifact));

    // The verdicts landed on the attempt record as well as in run.json.
    const attempt = JSON.parse(await readFile(path.join(fixture.directory, 'attempt-1.json'), 'utf8'));
    assert.equal(attempt.semantic.judge, 'host');
    assert.equal(attempt.semantic.checks.length, ASSERTIONS.length);

    const files = await readdir(fixture.directory);
    assert.ok(files.includes('judge-request-1.json'));
    assert.ok(files.includes('judge-result-1.json'));

    const result = JSON.parse(await readFile(path.join(fixture.directory, 'judge-result-1.json'), 'utf8'));
    assert.equal(result.schema, JUDGE_RESULT_SCHEMA);
    assert.equal(result.nonce, undefined, 'a used identity secret is not retained in evidence');
  } finally {
    await removeTemporaryDirectory(root);
  }
});

test('the same valid submission cannot be replayed', async () => {
  const root = await temporaryDirectory('pixelproof-judge-replay-');
  try {
    const fixture = await pendingFixture(root);
    const submission = submissionFor(fixture.record, 'pass');

    assert.equal((await submit(fixture, submission)).outcome, 'accepted');

    // Byte-identical, and still refused: finalisation moved the run off
    // pending-judgement, so the nonce has nothing left to open.
    await assert.rejects(
      () => submit(fixture, submission),
      (error) => error.code === 'PENDING_NOT_OPEN',
    );
  } finally {
    await removeTemporaryDirectory(root);
  }
});

test('a failing assertion rejects the run and never promotes', async () => {
  const root = await temporaryDirectory('pixelproof-judge-reject-');
  try {
    const out = path.join(root, 'delivered', 'hero.png');
    const fixture = await pendingFixture(root, { out });

    const applied = await submit(fixture, submissionFor(fixture.record, ['pass', 'fail']));
    assert.equal(applied.outcome, 'rejected');
    assert.equal(applied.reason, 'semantic-failed');
    assert.equal(applied.run.accepted, false);
    assert.equal(await exists(out), false, 'an unaccepted run leaves no file where a caller looks');
  } finally {
    await removeTemporaryDirectory(root);
  }
});

test('a judge that errored produced no verdicts, and no verdicts is not a pass', async () => {
  const root = await temporaryDirectory('pixelproof-judge-error-');
  try {
    const fixture = await pendingFixture(root);
    const submission = parseSubmission({
      runId: fixture.record.runId,
      nonce: fixture.record.nonce,
      checksDigest: fixture.record.checksDigest,
      response: {
        protocol: 1,
        ok: false,
        error: { code: 'INTERNAL', message: 'the vision model refused the image' },
      },
    });

    const applied = await submit(fixture, submission);
    assert.equal(applied.outcome, 'rejected');
    assert.equal(applied.reason, 'judge-error');
    assert.equal(applied.run.accepted, false);
  } finally {
    await removeTemporaryDirectory(root);
  }
});

test('unsure escalates to a terminal round carrying only the unsure checks', async () => {
  const root = await temporaryDirectory('pixelproof-judge-escalate-');
  try {
    const fixture = await pendingFixture(root);
    const first = await submit(fixture, submissionFor(fixture.record, ['pass', 'unsure']));

    assert.equal(first.outcome, 'escalated');
    assert.equal(first.record.round, 2);
    assert.equal(first.record.escalationTerminal, true);
    assert.equal(first.record.onUnsure, 'fail', 'round 2 cannot escalate again');
    assert.equal(first.record.request.checks.length, 1);
    assert.equal(first.record.request.checks[0].assertion, ASSERTIONS[1]);
    assert.notEqual(first.record.nonce, fixture.record.nonce, 'each round has its own identity');

    // The record must not tell the judge what it said last time: independence is
    // what makes ADR 0010's disagreement signal worth anything.
    const serialised = JSON.stringify(first.record);
    assert.equal(/"verdict"/.test(serialised), false);
    assert.equal(/unsure/.test(serialised.replace(/"onUnsure":"fail"/, '')), false);

    assert.equal((await readRun(fixture.directory)).state, 'pending-judgement');
  } finally {
    await removeTemporaryDirectory(root);
  }
});

test('a round-2 verdict replaces the escalated one rather than joining it', async () => {
  const root = await temporaryDirectory('pixelproof-judge-replace-');
  try {
    const fixture = await pendingFixture(root);
    const escalated = await submit(fixture, submissionFor(fixture.record, ['pass', 'unsure']));

    const second = await submit({ ...fixture, record: escalated.record }, submissionFor(escalated.record, 'pass'));

    // Joining would combine round-1 `unsure` with round-2 `pass` as `unsure`
    // under the default `all` policy, so escalation would resolve nothing.
    assert.equal(second.outcome, 'accepted');
    assert.equal(second.run.accepted, true);

    const replaced = second.checks.find((check) => check.assertion === ASSERTIONS[1]);
    assert.equal(replaced.verdict, 'pass');
    assert.equal(replaced.round, 2);
    assert.deepEqual(replaced.escalatedFrom, { round: 1, verdict: 'unsure' },
      'the replacement is recorded, not silently applied');
  } finally {
    await removeTemporaryDirectory(root);
  }
});

test('an assertion that stays unsure terminates in fail, never in a third round', async () => {
  const root = await temporaryDirectory('pixelproof-judge-terminal-');
  try {
    const fixture = await pendingFixture(root);
    const escalated = await submit(fixture, submissionFor(fixture.record, ['pass', 'unsure']));

    const second = await submit(
      { ...fixture, record: escalated.record },
      submissionFor(escalated.record, 'unsure'),
    );

    assert.equal(second.outcome, 'rejected');
    assert.equal(second.reason, 'semantic-unsure');
    assert.equal(second.run.state, 'rejected');
    assert.equal(await exists(path.join(fixture.directory, 'judge-request-3.json')), false);
  } finally {
    await removeTemporaryDirectory(root);
  }
});

test('a judge answering the wrong set of checks is a protocol violation', async () => {
  const root = await temporaryDirectory('pixelproof-judge-partial-');
  try {
    const fixture = await pendingFixture(root);
    const opened = await openPendingRun({ runId: fixture.runId, root: fixture.runRoot });

    const partial = submissionFor(fixture.record, 'pass');
    partial.response.results = partial.response.results.slice(0, 1);

    // A partial answer silently treated as complete is indistinguishable from a
    // pass, so the contract rejects it rather than tolerating it (ADR 0010).
    await assert.rejects(
      () => verifySubmission({
        record: opened.record, round: opened.round, submission: partial, directory: opened.directory,
      }),
      /does not answer exactly the checks that were asked/,
    );

    assert.equal((await readRun(fixture.directory)).state, 'pending-judgement',
      'a refused submission leaves the run answerable');
  } finally {
    await removeTemporaryDirectory(root);
  }
});

// --- schema parity --------------------------------------------------------

test('the judge schema documents describe the envelopes the code writes', async () => {
  const root = await temporaryDirectory('pixelproof-judge-parity-');
  try {
    const schemaFor = async (name) => JSON.parse(
      await readFile(new URL(`../schema/${name}`, import.meta.url), 'utf8'),
    );
    const pendingSchema = await schemaFor('judge-pending.v1.json');
    const resultSchema = await schemaFor('judge-result.v1.json');

    assert.equal(pendingSchema.properties.schema.const, JUDGE_PENDING_SCHEMA);
    assert.equal(resultSchema.properties.schema.const, JUDGE_RESULT_SCHEMA);
    assert.equal(pendingSchema.properties.maxRounds.const, MAX_ROUNDS);
    assert.equal(pendingSchema.additionalProperties, true, 'ADR 0014 §4 tolerance');
    assert.equal(resultSchema.additionalProperties, true);

    const fixture = await pendingFixture(root);
    for (const key of pendingSchema.required) {
      assert.ok(key in fixture.record, `the written pending record is missing ${key}`);
    }

    await submit(fixture, submissionFor(fixture.record, 'pass'));
    const result = JSON.parse(await readFile(path.join(fixture.directory, 'judge-result-1.json'), 'utf8'));
    for (const key of resultSchema.required) {
      assert.ok(key in result, `the written result record is missing ${key}`);
    }

    // `judge` and `rounds` are ADR 0014 §5's reserved keys. They are written
    // now, so `schema/run.v1.json` must describe them rather than still call
    // them unwritten.
    const runSchema = await schemaFor('run.v1.json');
    const run = await readRun(fixture.directory);
    assert.equal(runSchema.properties.judge.properties.kind.const, 'host');
    assert.equal(runSchema.properties.rounds.type, 'array');

    for (const key of runSchema.properties.rounds.items.required) {
      assert.ok(key in run.rounds[0], `the written round summary is missing ${key}`);
    }
    for (const key of runSchema.properties.judge.properties.checks.items.required) {
      assert.ok(key in run.judge.checks[0], `the written verdict is missing ${key}`);
    }
    assert.equal(run.rounds[0].submittedAt !== null, true, 'an answered round records when');
  } finally {
    await removeTemporaryDirectory(root);
  }
});
