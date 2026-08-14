/**
 * `generate --judge codex` through the real binary (ADR 0021 §3, §4, §5, §7).
 *
 * These drive `bin/pixelproof.mjs` as a child process, because the things worth
 * proving here are not return values: that the run **never enters
 * `pending-judgement`**, that exit 2 never appears, that the artifact reaches
 * `--out` only on acceptance, and that a correction assembled from a judge's own
 * evidence really reaches the next generation's prompt.
 *
 * ## What the fake is, and what it is not
 *
 * The vendor is a fake `codex` on PATH which serves **both roles**: asked to
 * generate it writes a PNG, asked to judge — it can tell, because a judging
 * invocation carries `--output-schema` — it reads the protocol-1 request from
 * stdin and writes a reply to the file named by `-o`. Nothing here calls the
 * real Codex, which is why these tests work while the account is over quota.
 *
 * **This proves the wiring, not the vendor.** That the real `codex exec` accepts
 * these flags and returns a schema-conforming reply for a real image was
 * verified once against codex-cli 0.147.0 for `judges/codex.mjs` in isolation;
 * the wired path has never run against the real vendor, and ADR 0021's proof
 * plan says so. That run happens on or after 2026-08-18, when quota returns.
 */

import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
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

const binaryPath = path.join(repositoryRoot, 'bin', 'pixelproof.mjs');

const SPEC = {
  description: 'A ceramic desk lamp on seamless white',
  mechanical: { width: 32, height: 32 },
  semantic: ['The frame contains exactly one lamp.'],
};

/**
 * A fake Codex that generates *and* judges.
 *
 * The two roles are told apart by `--output-schema`, which only a judging
 * invocation passes — the same flag `judges/codex.mjs` uses to pin the reply
 * shape. Each role counts its own calls, so the second *judgement* can differ
 * from the first regardless of how many generations happened between them.
 *
 * **Its configuration is a file, not the environment.** The judge transport
 * forwards only its allowlist (ADR 0007), so `PIXELPROOF_FAKE_VERDICT` would be
 * stripped on the way into a judging child and the fake would silently fall back
 * to a default — a test that passed for the wrong reason. The config path is
 * baked into the script when the workspace is built, and the counters live
 * beside it.
 *
 * The reply is built from the ids in the request it was handed. A fake that
 * invented ids would pass every test that matters here while proving nothing:
 * `parseJudgeResponse` rejects an answer to checks nobody asked about, and that
 * refusal is one of the things under test.
 *
 * Failures are written with `writeSync` and exit through `process.exitCode`
 * rather than `process.exit()`: a piped stderr is written asynchronously on
 * Windows, and exiting immediately truncates it — which reaches the judge as an
 * empty diagnostic and classifies as INTERNAL instead of AUTH_REQUIRED.
 */
function dualRoleFakeCodex(configPath) {
  return `
  import { writeSync } from 'node:fs';
  import { mkdir, readFile, writeFile } from 'node:fs/promises';
  import path from 'node:path';

  const CONFIG = ${JSON.stringify(configPath)};
  const config = JSON.parse(await readFile(CONFIG, 'utf8'));
  const stateDirectory = path.dirname(CONFIG);

  const encoded = process.env.PIXELPROOF_CODEX_ARGS_B64;
  const args = encoded
    ? JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))
    : process.argv.slice(2);

  async function count(name) {
    const file = path.join(stateDirectory, name);
    let next = 1;
    try { next = Number(await readFile(file, 'utf8')) + 1; } catch { next = 1; }
    await writeFile(file, String(next), 'utf8');
    return next;
  }

  async function readStdin() {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
  }

  if (!args.includes('--output-schema')) {
    const prompt = args[args.length - 1] ?? '';
    const call = await count('generations.txt');
    await mkdir(path.join(stateDirectory, 'prompts'), { recursive: true });
    await writeFile(
      path.join(stateDirectory, 'prompts', call + '.json'),
      JSON.stringify({ call, prompt }, null, 2),
    );

    const named = /Save it as exactly "([^"]+)"/.exec(prompt);
    const image = config.images[call - 1] ?? config.images[config.images.length - 1];
    if (named && image) await writeFile(path.join(process.cwd(), named[1]), await readFile(image));
  } else {
    const call = await count('judgements.txt');
    const request = JSON.parse(await readStdin());

    await mkdir(path.join(stateDirectory, 'requests'), { recursive: true });
    await writeFile(
      path.join(stateDirectory, 'requests', call + '.json'),
      JSON.stringify({ call, args, request }, null, 2),
    );

    const answer = config.judgements[call - 1] ?? config.judgements[config.judgements.length - 1] ?? {};

    if (answer.fail) {
      writeSync(2, answer.fail + '\\n');
      process.exitCode = 1;
    } else {
      const reply = {
        protocol: 1,
        ok: true,
        results: request.checks.map((check) => ({
          id: check.id,
          verdict: answer.verdict ?? 'pass',
          confidence: 0.9,
          evidence: answer.evidence ?? 'the fake judge looked',
        })),
      };
      const outputIndex = args.indexOf('-o');
      if (outputIndex !== -1) await writeFile(args[outputIndex + 1], JSON.stringify(reply), 'utf8');
    }
  }
`;
}

function pixelproof(args, options = {}) {
  return runScript(binaryPath, args, { cwd: repositoryRoot, ...options });
}

/**
 * A workspace with a spec, a run root, and a fake Codex configured to serve
 * `images[n]` on its nth generation and `judgements[n]` on its nth judgement.
 */
async function workspace(prefix, { sizes = [[32, 32]], spec = SPEC, judgements = [{ verdict: 'pass' }] } = {}) {
  const root = await temporaryDirectory(prefix);
  const specPath = path.join(root, 'spec.json');
  const runRoot = path.join(root, 'runs');
  const out = path.join(root, 'delivered', 'hero.png');
  const state = path.join(root, 'fake');
  const configPath = path.join(state, 'config.json');
  await writeFile(specPath, JSON.stringify(spec, null, 2));
  await mkdir(state, { recursive: true });

  const images = [];
  for (const [index, [width, height]] of sizes.entries()) {
    const file = path.join(root, `image-${index + 1}.png`);
    await writePng(file, width, height);
    images.push(file);
  }
  await writeFile(configPath, JSON.stringify({ images, judgements }, null, 2));

  const fake = await createFakeCodex(root, dualRoleFakeCodex(configPath));

  return {
    root,
    specPath,
    runRoot,
    out,
    prompt: (call) => path.join(state, 'prompts', `${call}.json`),
    request: (call) => path.join(state, 'requests', `${call}.json`),
    env: fake.env(),
  };
}

/** The single run directory the invocation created. */
async function onlyRun(runRoot) {
  const entries = await readdir(runRoot);
  assert.equal(entries.length, 1, `expected exactly one run directory, found ${entries.length}`);
  const directory = path.join(runRoot, entries[0]);
  return { directory, run: JSON.parse(await readFile(path.join(directory, 'run.json'), 'utf8')) };
}

async function exists(file) {
  try {
    await readFile(file);
    return true;
  } catch {
    return false;
  }
}

test('--judge codex accepts, promotes, and never pauses the run', async () => {
  const ws = await workspace('pixelproof-judge-codex-accept-');
  try {
    const result = pixelproof([
      'generate', '--prompt', 'a lamp', '--out', ws.out, '--spec', ws.specPath,
      '--provider', 'codex', '--judge', 'codex', '--run-dir', ws.runRoot,
    ], { env: ws.env });

    assert.equal(result.status, 0, `expected acceptance, got ${result.status}: ${result.stderr}`);
    assert.equal(await exists(ws.out), true, 'an accepted artifact is promoted to --out');

    const { directory, run } = await onlyRun(ws.runRoot);
    assert.equal(run.state, 'accepted');
    assert.equal(run.accepted, true);

    // ADR 0021 §5: the widened kind, and the panel recorded beside it.
    assert.equal(run.judge.kind, 'subprocess');
    assert.deepEqual(run.judge.panel, [{ id: 'codex', role: 'judge', trust: 'builtin', kind: 'subprocess' }]);

    // ADR 0021 §3: a subprocess judge is a call, not a state. The run must never
    // have been pending — which is checked on the *record of reasons*, not on the
    // final state, because a run that paused and resumed would still end
    // `accepted` and look identical from the outside.
    assert.equal(
      (run.reasons ?? []).some((reason) => reason.code === 'awaiting-host-judgement'),
      false,
      'a subprocess run never waits on a host',
    );

    // §5: the same evidence a host round leaves. The request is written before
    // the judge is spawned, so the question is on disk whatever the answer was.
    assert.equal(await exists(path.join(directory, 'judge-request-1.json')), true);
    assert.equal(await exists(path.join(directory, 'judge-result-1.json')), true);

    const attempt = JSON.parse(await readFile(path.join(directory, 'attempt-1.json'), 'utf8'));
    assert.equal(attempt.semantic.judge, 'codex', 'the verdict records who actually answered');
    assert.equal(attempt.semantic.checks[0].verdict, 'pass');

    // The judge was handed the real protocol-1 request, on stdin, with the same
    // check ids the checklist carries.
    const captured = JSON.parse(await readFile(ws.request(1), 'utf8'));
    assert.equal(captured.request.protocol, 1);
    assert.equal(captured.request.checks.length, 1);
    assert.equal(captured.request.checks[0].id, attempt.semantic.checks[0].id);
    assert.equal(captured.args.includes('--sandbox'), true, 'the judge looks; it does not write');
    assert.equal(captured.args.includes('-i'), true, 'the artifact is attached');
  } finally {
    await removeTemporaryDirectory(ws.root);
  }
});

test('a failing verdict rejects, promotes nothing, and exits 1 rather than 2', async () => {
  const ws = await workspace('pixelproof-judge-codex-reject-', {
    judgements: [{ verdict: 'fail', evidence: 'there are two lamps' }],
  });
  try {
    const result = pixelproof([
      'generate', '--prompt', 'a lamp', '--out', ws.out, '--spec', ws.specPath,
      '--provider', 'codex', '--judge', 'codex', '--run-dir', ws.runRoot,
    ], { env: ws.env });

    // 1, never 2: 2 means an outstanding judgement, and this one was answered.
    assert.equal(result.status, 1, result.stderr);
    assert.equal(await exists(ws.out), false, 'nothing is promoted on rejection');

    const { run } = await onlyRun(ws.runRoot);
    assert.equal(run.state, 'rejected');
    assert.equal(run.accepted, false);
    assert.equal(run.reasons.some((reason) => reason.code === 'semantic-failed'), true);
    assert.equal(run.attempts.length, 1, 'the default bound is one attempt');
  } finally {
    await removeTemporaryDirectory(ws.root);
  }
});

test('an unsure verdict with no host in the panel is rejected, and says why', async () => {
  const ws = await workspace('pixelproof-judge-codex-unsure-', {
    judgements: [{ verdict: 'unsure' }],
  });
  try {
    const result = pixelproof([
      'generate', '--prompt', 'a lamp', '--out', ws.out, '--spec', ws.specPath,
      '--provider', 'codex', '--judge', 'codex', '--run-dir', ws.runRoot,
    ], { env: ws.env });

    assert.equal(result.status, 1, result.stderr);
    assert.equal(await exists(ws.out), false, 'unsure is never a pass');

    const { directory, run } = await onlyRun(ws.runRoot);
    assert.equal(run.state, 'rejected');
    assert.equal(run.reasons.some((reason) => reason.code === 'semantic-unsure'), true);

    // ADR 0021 §6: the run must not have escalated, because there was nobody to
    // escalate to. One round issued, and no second request file — re-asking the
    // same judge would have produced both.
    assert.equal(run.rounds.length, 1, 'no escalation round was issued');
    assert.equal(await exists(path.join(directory, 'judge-request-2.json')), false);

    // Named on the record and on the terminal: an operator has to be able to see
    // that adding a host would have resolved it.
    assert.match(
      run.reasons.find((reason) => reason.code === 'semantic-unsure').message,
      /no escalation authority/,
    );
    assert.match(result.stdout, /Add ,host to --judge/);
  } finally {
    await removeTemporaryDirectory(ws.root);
  }
});

test('a rejected attempt retakes in the same process, corrected by the judge evidence', async () => {
  const ws = await workspace('pixelproof-judge-codex-retake-', {
    sizes: [[32, 32], [32, 32]],
    judgements: [
      { verdict: 'fail', evidence: 'the frame holds two lamps, not one' },
      { verdict: 'pass' },
    ],
  });
  try {
    const result = pixelproof([
      'generate', '--prompt', 'a lamp', '--out', ws.out, '--spec', ws.specPath,
      '--provider', 'codex', '--judge', 'codex', '--retakes', '2', '--run-dir', ws.runRoot,
    ], { env: ws.env });

    assert.equal(result.status, 0, `expected the second attempt to be accepted: ${result.stderr}`);
    assert.equal(await exists(ws.out), true);

    const { directory, run } = await onlyRun(ws.runRoot);
    assert.equal(run.attempts.length, 2, 'ADR 0021 §7: the retake happened here, not in a later command');
    assert.equal(run.state, 'accepted');

    // Round numbers run across the run (ADR 0020 §5), so the second attempt's
    // checklist is round 2 and does not overwrite the first.
    assert.deepEqual(run.rounds.map((round) => round.round), [1, 2]);
    assert.deepEqual(run.rounds.map((round) => round.attempt), [1, 2]);
    assert.equal(await exists(path.join(directory, 'judge-request-2.json')), true);

    // The correction reached the provider — assembled from the judge's own
    // evidence, verbatim, and never invented. This is the half no core test can
    // show: that the two ends of the loop are actually connected.
    const second = JSON.parse(await readFile(ws.prompt(2), 'utf8'));
    assert.match(second.prompt, /the frame holds two lamps, not one/);
    assert.match(second.prompt, /Corrections from attempt 1/);

    const first = JSON.parse(await readFile(ws.prompt(1), 'utf8'));
    assert.equal(/Corrections from attempt/.test(first.prompt), false, 'the first attempt corrects nothing');
  } finally {
    await removeTemporaryDirectory(ws.root);
  }
});

test('a judge that errors rejects the run and never spends a retake', async () => {
  const ws = await workspace('pixelproof-judge-codex-error-', {
    sizes: [[32, 32], [32, 32]],
    judgements: [{ fail: '401 Unauthorized: Missing bearer or basic authentication' }],
  });
  try {
    const result = pixelproof([
      'generate', '--prompt', 'a lamp', '--out', ws.out, '--spec', ws.specPath,
      '--provider', 'codex', '--judge', 'codex', '--retakes', '2', '--run-dir', ws.runRoot,
    ], { env: ws.env });

    assert.equal(result.status, 1, result.stderr);
    assert.equal(await exists(ws.out), false, 'no verdicts is not a pass');

    const { directory, run } = await onlyRun(ws.runRoot);
    assert.equal(run.state, 'rejected');
    assert.equal(run.reasons.some((reason) => reason.code === 'judge-error'), true);

    // ADR 0020, unchanged by ADR 0021: an errored judge says the *judging*
    // failed, not the artifact, so correcting the prompt would correct the wrong
    // thing. The bound was 2 and exactly one attempt was made.
    assert.equal(run.attempts.length, 1, 'an errored judge does not open a retake');

    // The failure is written down, not merely printed: the result record is
    // where an operator looks after the terminal has scrolled away.
    const recorded = JSON.parse(await readFile(path.join(directory, 'judge-result-1.json'), 'utf8'));
    assert.equal(recorded.response.ok, false);
    assert.match(JSON.stringify(recorded.response.error), /401|AUTH_REQUIRED/);
  } finally {
    await removeTemporaryDirectory(ws.root);
  }
});

test('verify --judge codex judges an image somebody else made', async () => {
  // `verify` passes no `regenerate` and resolves its bound to 1, so the retake
  // branch has to be genuinely unreachable rather than merely unused: a run that
  // came back `retakeable` here would have nothing able to retake it. Both
  // outcomes are driven, because only the rejecting one can reach that branch.
  const ws = await workspace('pixelproof-judge-codex-verify-');
  const rejecting = await workspace('pixelproof-judge-codex-verify-reject-', {
    judgements: [{ verdict: 'fail', evidence: 'no lamp is visible' }],
  });
  try {
    const accepted = pixelproof([
      'verify', '--file', path.join(ws.root, 'image-1.png'), '--spec', ws.specPath,
      '--judge', 'codex', '--run-dir', ws.runRoot,
    ], { env: ws.env });

    assert.equal(accepted.status, 0, `expected acceptance: ${accepted.stderr}`);
    const run = (await onlyRun(ws.runRoot)).run;
    assert.equal(run.state, 'accepted');
    assert.equal(run.judge.kind, 'subprocess');
    // `verify` has no `--out`, so there is nothing to promote on acceptance; the
    // run directory holds the copy the judge was actually asked about.
    assert.equal(run.resolved.out, null);

    const failed = pixelproof([
      'verify', '--file', path.join(rejecting.root, 'image-1.png'), '--spec', rejecting.specPath,
      '--judge', 'codex', '--run-dir', rejecting.runRoot,
    ], { env: rejecting.env });

    assert.equal(failed.status, 1, failed.stderr);
    const rejected = (await onlyRun(rejecting.runRoot)).run;
    assert.equal(rejected.state, 'rejected', 'a bound of one finalises rather than offering a retake');
    assert.equal(rejected.attempts.length, 1);
  } finally {
    await removeTemporaryDirectory(ws.root);
    await removeTemporaryDirectory(rejecting.root);
  }
});

test('a judge that is not installed is refused before a generation is spent', async () => {
  const ws = await workspace('pixelproof-judge-codex-missing-');
  try {
    // The fake is removed from PATH, so nothing resolves as `codex`. The
    // provider would still fail later — but the point is that it is never
    // reached: a missing CLI is not a verdict about an artifact, and a run that
    // generated first would reject an image nothing ever looked at.
    const result = pixelproof([
      'generate', '--prompt', 'a lamp', '--out', ws.out, '--spec', ws.specPath,
      '--provider', 'codex', '--judge', 'codex', '--run-dir', ws.runRoot,
    ], { env: { ...ws.env, PATH: path.join(ws.root, 'empty'), Path: path.join(ws.root, 'empty') } });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /--judge codex is not usable here/);
    assert.match(result.stderr, /npm install -g @openai\/codex/, 'the refusal carries its remediation');

    // Nothing was created: no run directory, no attempt, no artifact.
    assert.equal(await exists(ws.runRoot), false, 'no run directory is opened');
    assert.equal(await exists(ws.out), false);
  } finally {
    await removeTemporaryDirectory(ws.root);
  }
});
