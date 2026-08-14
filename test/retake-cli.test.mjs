import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  createFakeCodex,
  removeTemporaryDirectory,
  repositoryRoot,
  runScript,
  temporaryDirectory,
  writePng,
} from './helpers/compat-harness.mjs';

/**
 * Retakes through the real binary (ADR 0020).
 *
 * `test/retake.test.mjs` drives the core in process. These cases spawn
 * `bin/pixelproof.mjs`, for the reason ADR 0009's tests already spawn it: an
 * in-process return value does not prove the process exits 2, and 2 is the code
 * a CI gate reads. They also prove the halves fit together — that the correction
 * assembled from a recorded verdict really does reach the provider's prompt,
 * which no core test can show.
 *
 * The provider is a fake `codex` on PATH. It reads the target filename out of
 * the composed prompt, counts its own invocations, and serves a different image
 * per call, so a first attempt can fail mechanically and a second can pass —
 * exactly the sequence a retake exists for. Nothing here calls the real Codex,
 * which is also why these tests work while the account is over quota.
 */

const binaryPath = path.join(repositoryRoot, 'bin', 'pixelproof.mjs');

const SPEC = {
  description: 'A ceramic desk lamp on seamless white',
  mechanical: { width: 32, height: 32 },
  semantic: ['The frame contains exactly one lamp.'],
};

/**
 * A fake Codex that serves `PIXELPROOF_FAKE_IMAGE_<n>` on its nth invocation and
 * records the prompt it was given each time.
 *
 * The target filename is parsed from the prompt rather than passed in an
 * environment variable, because it changes per attempt (`attempt-1.png`,
 * `attempt-2.png`) while the environment of one CLI invocation does not.
 */
const COUNTING_FAKE_CODEX = `
  import { mkdir, readFile, writeFile } from 'node:fs/promises';
  import path from 'node:path';

  const encoded = process.env.PIXELPROOF_CODEX_ARGS_B64;
  const args = encoded
    ? JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))
    : process.argv.slice(2);
  const prompt = args[args.length - 1] ?? '';

  let call = 1;
  const state = process.env.PIXELPROOF_FAKE_STATE;
  if (state) {
    try { call = Number(await readFile(state, 'utf8')) + 1; } catch { call = 1; }
    await writeFile(state, String(call), 'utf8');
  }

  if (process.env.PIXELPROOF_FAKE_CAPTURE) {
    await mkdir(path.dirname(process.env.PIXELPROOF_FAKE_CAPTURE), { recursive: true });
    await writeFile(
      \`\${process.env.PIXELPROOF_FAKE_CAPTURE}.\${call}.json\`,
      JSON.stringify({ call, prompt }, null, 2),
    );
  }

  const named = /Save it as exactly "([^"]+)"/.exec(prompt);
  const target = named ? named[1] : process.env.PIXELPROOF_FAKE_OUT;
  const image = process.env[\`PIXELPROOF_FAKE_IMAGE_\${call}\`] ?? process.env.PIXELPROOF_FAKE_IMAGE;
  if (target && image) {
    await writeFile(path.join(process.cwd(), target), await readFile(image));
  }
`;

function pixelproof(args, options = {}) {
  return runScript(binaryPath, args, { cwd: repositoryRoot, ...options });
}

/**
 * A workspace with a spec, a run root, a fake Codex, and one PNG per planned
 * attempt. `sizes` names the dimensions each successive generation produces.
 */
async function workspace(prefix, { sizes = [[32, 32]], spec = SPEC } = {}) {
  const root = await temporaryDirectory(prefix);
  const specPath = path.join(root, 'spec.json');
  const runRoot = path.join(root, 'runs');
  const out = path.join(root, 'delivered', 'hero.png');
  const capture = path.join(root, 'capture');
  await writeFile(specPath, JSON.stringify(spec, null, 2));

  const fake = await createFakeCodex(root, COUNTING_FAKE_CODEX);
  const images = {};
  for (const [index, [width, height]] of sizes.entries()) {
    const file = path.join(root, `image-${index + 1}.png`);
    await writePng(file, width, height);
    images[`PIXELPROOF_FAKE_IMAGE_${index + 1}`] = file;
  }

  const env = fake.env({
    PIXELPROOF_FAKE_STATE: path.join(root, 'calls.txt'),
    PIXELPROOF_FAKE_CAPTURE: capture,
    ...images,
  });

  return { root, specPath, runRoot, out, capture, env };
}

async function onlyRunDirectory(runRoot) {
  const entries = await readdir(runRoot);
  assert.equal(entries.length, 1, `expected exactly one run directory, found ${entries.join(', ')}`);
  return path.join(runRoot, entries[0]);
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

/** The prompt the fake Codex was given on its nth call. */
async function promptOnCall(workspaceRoot, call) {
  return (await readJson(`${path.join(workspaceRoot, 'capture')}.${call}.json`)).prompt;
}

function verdicts(record, verdict, evidence) {
  return JSON.stringify({
    runId: record.runId,
    nonce: record.nonce,
    checksDigest: record.checksDigest,
    round: record.round,
    response: {
      protocol: 1,
      ok: true,
      judge: 'host',
      results: record.request.checks.map((check) => ({ id: check.id, verdict, evidence })),
    },
  });
}

// --- the mechanical loop, inside one process -------------------------------

test('a mechanical failure with the bound unspent is corrected and regenerated in place', async () => {
  const ws = await workspace('pixelproof-retake-cli-mech-', { sizes: [[32, 48], [32, 32]] });
  try {
    const result = pixelproof([
      'generate',
      '--prompt', 'A ceramic desk lamp on seamless white',
      '--out', ws.out,
      '--spec', ws.specPath,
      '--judge', 'host',
      '--retakes', '2',
      '--run-dir', ws.runRoot,
    ], { env: ws.env });

    assert.equal(result.status, 2, `expected a pending judgement, got ${result.status}: ${result.stderr}`);
    assert.match(result.stdout, /Attempt 1 failed 1 mechanical check\(s\)\. Retaking: attempt 2 of 2\./);
    assert.match(result.stdout, /Pending host judgement/);

    const directory = await onlyRunDirectory(ws.runRoot);
    const run = await readJson(path.join(directory, 'run.json'));

    // Both attempts live in the same run directory, numbered and contiguous.
    assert.deepEqual(run.attempts.map((attempt) => attempt.number), [1, 2]);
    assert.equal(run.attempts[0].verification.ok, false);
    assert.equal(run.attempts[1].verification.ok, true);
    const files = await readdir(directory);
    assert.ok(files.includes('attempt-1.png') && files.includes('attempt-2.png'), files.join(', '));
    assert.ok(files.includes('attempt-1.json') && files.includes('attempt-2.json'), files.join(', '));

    // The host is asked about attempt 2, and only attempt 2. No round was ever
    // spent on the mechanically failed one.
    assert.equal(run.judge.attempt, 2);
    assert.deepEqual(run.rounds.map((round) => [round.round, round.attempt]), [[1, 2]]);
    const record = await readJson(path.join(directory, 'judge-request-1.json'));
    assert.equal(record.artifact.path, 'attempt-2.png');

    // The correction reached the generator, carrying the value the tool
    // measured itself rather than a paraphrase of it.
    const second = await promptOnCall(ws.root, 2);
    assert.match(second, /Corrections from attempt 1, which was not accepted:/);
    assert.match(second, /Measured height: expected 32, got 48/);
    assert.ok(
      second.indexOf('Pixelproof spec constraints:') < second.indexOf('Corrections from attempt 1'),
      'the corrections come after the folded spec, so they are the last thing the generator reads',
    );

    // And the first call carried no corrections: there was nothing to correct.
    assert.doesNotMatch(await promptOnCall(ws.root, 1), /Corrections from attempt/);

    // Nothing at --out: the run is pending, not accepted.
    await assert.rejects(() => readFile(ws.out), { code: 'ENOENT' });
  } finally {
    await removeTemporaryDirectory(ws.root);
  }
});

test('a bound spent on mechanical failures rejects and promotes nothing', async () => {
  const ws = await workspace('pixelproof-retake-cli-spent-', { sizes: [[32, 48], [48, 32]] });
  try {
    const result = pixelproof([
      'generate',
      '--prompt', 'A ceramic desk lamp on seamless white',
      '--out', ws.out,
      '--spec', ws.specPath,
      '--judge', 'host',
      '--retakes', '2',
      '--run-dir', ws.runRoot,
    ], { env: ws.env });

    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /Rejected on the mechanical tier/);

    const directory = await onlyRunDirectory(ws.runRoot);
    const run = await readJson(path.join(directory, 'run.json'));
    assert.equal(run.state, 'rejected');
    assert.equal(run.outcome.reason, 'retakes-exhausted');
    assert.deepEqual(run.attempts.map((attempt) => attempt.number), [1, 2]);
    assert.equal(run.attempts.length, 2, 'the bound is a bound: no third attempt was spent');

    // ADR 0020 §7: nothing is promoted on exhaustion, and both candidates are
    // named in the report so an operator can choose one by hand.
    await assert.rejects(() => readFile(ws.out), { code: 'ENOENT' });
    const report = await readJson(path.join(directory, 'report.json'));
    assert.deepEqual(report.attempts.map((attempt) => attempt.number), [1, 2]);
  } finally {
    await removeTemporaryDirectory(ws.root);
  }
});

// --- the semantic loop, across processes -----------------------------------

test('a semantic rejection leaves the run open, and retake carries the judge\'s own words', async () => {
  const ws = await workspace('pixelproof-retake-cli-semantic-', { sizes: [[32, 32], [32, 32]] });
  try {
    const opened = pixelproof([
      'generate',
      '--prompt', 'A ceramic desk lamp on seamless white',
      '--out', ws.out,
      '--spec', ws.specPath,
      '--judge', 'host',
      '--retakes', '2',
      '--run-dir', ws.runRoot,
    ], { env: ws.env });
    assert.equal(opened.status, 2, opened.stderr);

    const directory = await onlyRunDirectory(ws.runRoot);
    const first = await readJson(path.join(directory, 'judge-request-1.json'));

    // The host says no. The bound is unspent, so the run stays open — exit 1,
    // not 2: nothing is outstanding, and nothing was accepted either.
    const rejected = pixelproof(
      ['judge', 'submit', '--run', first.runId, '--results', '-', '--run-dir', ws.runRoot],
      { input: verdicts(first, 'fail', 'two lamps are visible, one reflected in the backdrop'), env: ws.env },
    );
    assert.equal(rejected.status, 1, rejected.stderr);
    assert.match(rejected.stdout, /Attempt 1 was rejected\. 1 of 2 attempt\(s\) remain/);
    assert.match(rejected.stdout, /two lamps are visible, one reflected in the backdrop/);
    assert.match(rejected.stdout, new RegExp(`pixelproof retake --run ${first.runId}`));
    assert.match(rejected.stdout, /pixelproof judge abandon/);

    let run = await readJson(path.join(directory, 'run.json'));
    assert.equal(run.state, 'running');
    assert.equal(run.accepted, null);
    assert.equal(run.outcome, null);

    // `judge pending` sees nothing — correctly, nothing is pending — and doctor
    // is where the open run stays visible (ADR 0020's named consequence).
    const pending = pixelproof(['judge', 'pending', '--run-dir', ws.runRoot], { env: ws.env });
    assert.equal(pending.status, 0, 'nothing is outstanding, so this is not a pending-judgement exit');
    assert.match(pending.stdout, /No run is waiting on a host judgement\./);

    const doctor = pixelproof(['doctor', '--run-dir', ws.runRoot], { env: ws.env });
    assert.match(doctor.stdout, /judgements: {2,}none pending; 1 run open between attempts/);

    // Spend the next attempt.
    const retaken = pixelproof(
      ['retake', '--run', first.runId, '--run-dir', ws.runRoot],
      { env: ws.env },
    );
    assert.equal(retaken.status, 2, retaken.stderr);
    assert.match(retaken.stdout, /attempt 2 of 2/);

    // The judge's evidence reached the generator verbatim, and the spec fold
    // still happened.
    const second = await promptOnCall(ws.root, 2);
    assert.match(second, /The judge reported: two lamps are visible, one reflected in the backdrop/);
    assert.match(second, /"The frame contains exactly one lamp\." was not satisfied\./);
    assert.match(second, /Pixelproof spec constraints:/);

    run = await readJson(path.join(directory, 'run.json'));
    assert.equal(run.state, 'pending-judgement');
    assert.deepEqual(run.attempts.map((attempt) => attempt.number), [1, 2]);
    assert.deepEqual(run.rounds.map((round) => [round.round, round.attempt]), [[1, 1], [2, 2]]);
    assert.equal(run.judge.attempt, 2);

    // Attempt 2's checklist is a new round with a new nonce.
    const nextRecord = await readJson(path.join(directory, 'judge-request-2.json'));
    assert.equal(nextRecord.attempt, 2);
    assert.equal(nextRecord.roundInAttempt, 1);
    assert.equal(nextRecord.artifact.path, 'attempt-2.png');
    assert.notEqual(nextRecord.nonce, first.nonce);

    // Attempt 1's nonce is not a key to attempt 2's round.
    const replay = pixelproof(
      ['judge', 'submit', '--run', first.runId, '--results', '-', '--run-dir', ws.runRoot],
      { input: verdicts(first, 'pass', 'replayed'), env: ws.env },
    );
    assert.equal(replay.status, 1);
    assert.match(replay.stderr, /Judge error: PENDING_NOT_OPEN/);

    // And the honest answer accepts, promoting attempt 2 and nothing else.
    const accepted = pixelproof(
      ['judge', 'submit', '--run', first.runId, '--results', '-', '--run-dir', ws.runRoot],
      { input: verdicts(nextRecord, 'pass', 'one lamp, no reflection'), env: ws.env },
    );
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.match(accepted.stdout, /Accepted: semantic-passed/);

    run = await readJson(path.join(directory, 'run.json'));
    assert.equal(run.outcome.acceptedAttempt, 2);
    assert.deepEqual(
      await readFile(ws.out),
      await readFile(path.join(directory, 'attempt-2.png')),
      'the promoted bytes are the attempt the host actually accepted',
    );
  } finally {
    await removeTemporaryDirectory(ws.root);
  }
});

test('a run left open between attempts can still be closed on the record', async () => {
  const ws = await workspace('pixelproof-retake-cli-abandon-', { sizes: [[32, 32]] });
  try {
    assert.equal(pixelproof([
      'generate', '--prompt', 'A ceramic desk lamp on seamless white',
      '--out', ws.out, '--spec', ws.specPath,
      '--judge', 'host', '--retakes', '3', '--run-dir', ws.runRoot,
    ], { env: ws.env }).status, 2);

    const directory = await onlyRunDirectory(ws.runRoot);
    const record = await readJson(path.join(directory, 'judge-request-1.json'));

    pixelproof(
      ['judge', 'submit', '--run', record.runId, '--results', '-', '--run-dir', ws.runRoot],
      { input: verdicts(record, 'fail', 'the backdrop has a visible seam'), env: ws.env },
    );

    const closed = pixelproof([
      'judge', 'abandon', '--run', record.runId,
      '--reason', 'the brief changed', '--run-dir', ws.runRoot,
    ], { env: ws.env });
    assert.equal(closed.status, 1, closed.stderr);
    assert.match(closed.stdout, /closed as rejected: the brief changed/);

    const run = await readJson(path.join(directory, 'run.json'));
    assert.equal(run.state, 'rejected');

    // The submitted judgement survived the close. An abandon that discarded a
    // verdict somebody had already given would be a new way to lose evidence.
    const attempt = await readJson(path.join(directory, 'attempt-1.json'));
    assert.equal(attempt.semantic.checks[0].verdict, 'fail');
    assert.equal(attempt.semantic.checks[0].evidence, 'the backdrop has a visible seam');
    assert.equal(run.judge.checks[0].verdict, 'fail');

    const report = await readJson(path.join(directory, 'report.json'));
    assert.ok(report.reasons.some((reason) => reason.code === 'judgement-abandoned'));
    assert.ok(report.reasons.some((reason) => reason.code === 'retake-available'));

    // Closed is closed: the same run cannot now be retaken.
    const late = pixelproof(['retake', '--run', record.runId, '--run-dir', ws.runRoot], { env: ws.env });
    assert.equal(late.status, 1);
    assert.match(late.stderr, /RETAKE_NOT_OPEN/);
  } finally {
    await removeTemporaryDirectory(ws.root);
  }
});

// --- what retake and --retakes refuse ---------------------------------------

test('--retakes is refused everywhere it could only mislead, before anything is spent', async () => {
  const ws = await workspace('pixelproof-retake-cli-refusals-', { sizes: [[32, 32]] });
  try {
    // Without --judge there is one provider call and nothing to correct, so a
    // bound would only change what the call costs.
    const unjudged = pixelproof([
      'generate', '--prompt', 'a lamp', '--out', ws.out,
      '--spec', ws.specPath, '--retakes', '3', '--run-dir', ws.runRoot,
    ], { env: ws.env });
    assert.equal(unjudged.status, 1);
    assert.match(unjudged.stderr, /--retakes only means something with --judge/);
    await assert.rejects(() => readdir(ws.runRoot), { code: 'ENOENT' },
      'the refusal happens before a run directory is opened');

    // The svg provider is given markup, not a prompt: a second attempt would
    // reproduce the first byte for byte.
    const svg = pixelproof([
      'generate', '--provider', 'svg', '--svg-file', ws.specPath, '--out', ws.out,
      '--spec', ws.specPath, '--judge', 'host', '--retakes', '2', '--run-dir', ws.runRoot,
    ], { env: ws.env });
    assert.equal(svg.status, 1);
    assert.match(svg.stderr, /--retakes needs a prompt-driven provider/);

    // A bound of zero is a mistake, not a configuration.
    const zero = pixelproof([
      'generate', '--prompt', 'a lamp', '--out', ws.out,
      '--spec', ws.specPath, '--judge', 'host', '--retakes', '0', '--run-dir', ws.runRoot,
    ], { env: ws.env });
    assert.equal(zero.status, 1);
    assert.match(zero.stderr, /--retakes must be a whole number of attempts/);

    // `verify` has no provider call to repeat, so the flag does not exist there.
    const verified = pixelproof(['verify', '--file', ws.specPath, '--retakes', '2'], { env: ws.env });
    assert.equal(verified.status, 1);
    assert.match(verified.stderr, /Error: Unknown argument: --retakes/);
  } finally {
    await removeTemporaryDirectory(ws.root);
  }
});

test('retake refuses a run it must not continue, and says which reason applies', async () => {
  const ws = await workspace('pixelproof-retake-cli-guard-', { sizes: [[32, 32]] });
  try {
    const missing = pixelproof(['retake', '--run-dir', ws.runRoot], { env: ws.env });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /--run <id> is required/);

    const malformed = pixelproof(['retake', '--run', '../../etc', '--run-dir', ws.runRoot], { env: ws.env });
    assert.equal(malformed.status, 1);
    assert.match(malformed.stderr, /PENDING_ID_MALFORMED/);

    assert.equal(pixelproof([
      'generate', '--prompt', 'a lamp', '--out', ws.out, '--spec', ws.specPath,
      '--judge', 'host', '--retakes', '2', '--run-dir', ws.runRoot,
    ], { env: ws.env }).status, 2);

    const record = await readJson(path.join(await onlyRunDirectory(ws.runRoot), 'judge-request-1.json'));

    // An outstanding judgement is answered or abandoned, never generated over.
    const outstanding = pixelproof(['retake', '--run', record.runId, '--run-dir', ws.runRoot], { env: ws.env });
    assert.equal(outstanding.status, 1);
    assert.match(outstanding.stderr, /RETAKE_NOT_OPEN/);
    assert.match(outstanding.stderr, /answer or abandon the outstanding judgement first/);

    // Accepting is terminal, and a terminal run is refused for being closed
    // rather than for its bound — the two codes are not interchangeable.
    pixelproof(
      ['judge', 'submit', '--run', record.runId, '--results', '-', '--run-dir', ws.runRoot],
      { input: verdicts(record, 'pass', 'one lamp'), env: ws.env },
    );
    const closed = pixelproof(['retake', '--run', record.runId, '--run-dir', ws.runRoot], { env: ws.env });
    assert.equal(closed.status, 1);
    assert.match(closed.stderr, /RETAKE_NOT_OPEN/);
    assert.match(closed.stderr, /a closed run is never reopened/);
  } finally {
    await removeTemporaryDirectory(ws.root);
  }
});

test('retake is in the registry and its help says what it costs', () => {
  const help = pixelproof(['retake', '--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /pixelproof retake --run <id>/);
  assert.match(help.stdout, /Exit codes: 1 rejected or refused, 2 an outstanding judgement/);
  assert.match(help.stdout, /Nothing is promoted on exhaustion/);

  const top = pixelproof(['--help']);
  assert.equal(top.status, 0);
  assert.match(top.stdout, /^ {2}retake {2,}Spend another attempt on a run whose last one was rejected/m);
  assert.match(top.stdout, /--retakes <n>/);
});
