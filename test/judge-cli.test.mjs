/**
 * `pixelproof judge` and the `--judge host` path, at the CLI (ADR 0009).
 *
 * The end-to-end cases **spawn the real binary** rather than calling `main()`
 * in-process, for one reason: exit code 2 is the load-bearing part of this
 * design, and an in-process test asserting a returned number would not prove
 * that `bin/pixelproof.mjs` actually exits with it. Every gate already written
 * as "non-zero is failure" depends on that, so it is verified the way a gate
 * would meet it.
 *
 * The cheap cases run in-process against a console stub, which is how
 * `test/cli-surface.test.mjs` already exercises presentation.
 *
 * Every case passes `--run-dir` explicitly. A test that wrote into the
 * repository's own `.pixelproof/` would leave state behind for the next one —
 * and this project has already shipped a red release because a test read a
 * fixture out of a gitignored scratch directory.
 */

import assert from 'node:assert/strict';
import { Console } from 'node:console';
import { access, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';

import { doctorCommand } from '../surfaces/cli/commands/doctor.mjs';
import { runJudge } from '../surfaces/cli/commands/judge.mjs';
import { GENERATE_USAGE, VERIFY_USAGE } from '../surfaces/cli/parse.mjs';
import {
  removeTemporaryDirectory,
  repositoryRoot,
  runScript,
  temporaryDirectory,
  writePng,
} from './helpers/compat-harness.mjs';

const binaryPath = path.join(repositoryRoot, 'bin', 'pixelproof.mjs');

const SPEC = {
  name: 'hero',
  description: 'Square hero on seamless white',
  mechanical: { width: 32, height: 32 },
  semantic: ['Zero text anywhere in the frame', 'No people or hands appear anywhere'],
};

function capture() {
  let stdout = '';
  let stderr = '';
  const sink = (append) => new Writable({
    write(chunk, _encoding, done) {
      append(String(chunk));
      done();
    },
  });
  return {
    output: new Console({
      stdout: sink((text) => { stdout += text; }),
      stderr: sink((text) => { stderr += text; }),
    }),
    get stdout() { return stdout; },
    get stderr() { return stderr; },
  };
}

function pixelproof(args, options = {}) {
  return runScript(binaryPath, args, { cwd: repositoryRoot, ...options });
}

/** A temp workspace with an image, a spec, and an isolated run root. */
async function workspace(prefix, { spec = SPEC, width = 32, height = 32 } = {}) {
  const root = await temporaryDirectory(prefix);
  const image = path.join(root, 'hero.png');
  const specPath = path.join(root, 'spec.json');
  const runRoot = path.join(root, 'runs');
  await writePng(image, width, height);
  await writeFile(specPath, JSON.stringify(spec, null, 2));
  return { root, image, specPath, runRoot };
}

async function onlyRunDirectory(runRoot) {
  const entries = await readdir(runRoot);
  assert.equal(entries.length, 1, `expected exactly one run directory, found ${entries.join(', ')}`);
  return path.join(runRoot, entries[0]);
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

// --- routing and help -----------------------------------------------------

test('judge routes its sub-verbs and refuses anything else', async () => {
  const missing = capture();
  assert.equal(await runJudge([], { output: missing.output }), 1);
  assert.match(missing.stderr, /^Error: a judge sub-command is required/);

  const unknown = capture();
  assert.equal(await runJudge(['inspect'], { output: unknown.output }), 1);
  assert.match(unknown.stderr, /Unknown judge sub-command: inspect\./);
  assert.match(unknown.stderr, /Available: pending, show, submit, abandon/);

  const help = capture();
  assert.equal(await runJudge(['--help'], { output: help.output }), 0);
  assert.match(help.stdout, /pixelproof host judgement/);
  assert.match(help.stdout, /Exit 2 is never a pass\./);

  // The sub-verb must be peeled before flag parsing: parseArguments throws
  // "Unknown argument: submit" on a bare word, by design.
  const verbHelp = capture();
  assert.equal(await runJudge(['submit', '--help'], { output: verbHelp.output }), 0);
  assert.match(verbHelp.stdout, /pixelproof host judgement/);
});

test('judge pending exits 0 and says so when nothing is outstanding', async () => {
  const root = await temporaryDirectory('pixelproof-judge-cli-empty-');
  try {
    const stub = capture();
    const code = await runJudge(['pending', '--run-dir', path.join(root, 'never-written')], { output: stub.output });
    assert.equal(code, 0);
    assert.match(stub.stdout, /No run is waiting on a host judgement\./);
  } finally {
    await removeTemporaryDirectory(root);
  }
});

test('submit needs a source of verdicts and refuses two of them', async () => {
  const neither = capture();
  assert.equal(await runJudge(['submit'], { output: neither.output }), 1);
  assert.match(neither.stderr, /needs --results <path>, --results - or --interactive/);

  const both = capture();
  assert.equal(await runJudge(['submit', '--results', 'x.json', '--interactive'], { output: both.output }), 1);
  assert.match(both.stderr, /two different sources of verdicts/);
});

test('interactive refuses a non-TTY instead of hanging the pipeline', async () => {
  const workspaceRoot = await workspace('pixelproof-judge-cli-tty-');
  try {
    const opened = pixelproof([
      'verify', '--file', workspaceRoot.image, '--spec', workspaceRoot.specPath,
      '--judge', 'host', '--run-dir', workspaceRoot.runRoot,
    ]);
    assert.equal(opened.status, 2);

    // Spawned with a pipe for stdin, so isTTY is false — exactly a CI shell.
    const attempted = pixelproof(
      ['judge', 'submit', '--interactive', '--run-dir', workspaceRoot.runRoot],
      { input: '' },
    );
    assert.equal(attempted.status, 1);
    assert.match(attempted.stderr, /--interactive needs a terminal/);
  } finally {
    await removeTemporaryDirectory(workspaceRoot.root);
  }
});

// --- the two-invocation cycle --------------------------------------------

test('verify --judge host exits 2, prints the checklist, and accepts on submission', async () => {
  const ws = await workspace('pixelproof-judge-cli-cycle-');
  try {
    const opened = pixelproof([
      'verify', '--file', ws.image, '--spec', ws.specPath,
      '--judge', 'host', '--run-dir', ws.runRoot,
    ]);

    assert.equal(opened.status, 2, 'a pending judgement is exit 2, and 2 is never a pass');
    assert.match(opened.stdout, /Pending host judgement/);
    assert.match(opened.stdout, /exit code 2 means an outstanding judgement, not a pass/);
    assert.match(opened.stdout, /Zero text anywhere in the frame/);
    assert.match(opened.stdout, /pixelproof judge submit --run /);

    const directory = await onlyRunDirectory(ws.runRoot);
    const record = JSON.parse(await readFile(path.join(directory, 'judge-request-1.json'), 'utf8'));

    const listed = pixelproof(['judge', 'pending', '--run-dir', ws.runRoot]);
    assert.equal(listed.status, 2, 'judge pending is usable as a CI or pre-commit guard');
    assert.match(listed.stdout, new RegExp(record.runId));

    const asJson = pixelproof(['judge', 'pending', '--json', '--run-dir', ws.runRoot]);
    const parsed = JSON.parse(asJson.stdout);
    assert.equal(parsed.count, 1);
    assert.equal(parsed.pending[0].expired, false);
    assert.equal(parsed.pending[0].checks, SPEC.semantic.length);

    const shown = pixelproof(['judge', 'show', '--run', record.runId, '--request', '--run-dir', ws.runRoot]);
    assert.equal(shown.status, 0);
    const request = JSON.parse(shown.stdout);
    assert.equal(request.protocol, 1);
    // Absolute, so a subprocess judge in another working directory can open it.
    assert.equal(path.isAbsolute(request.file), true);
    assert.equal(request.context, SPEC.description);

    const verdicts = JSON.stringify({
      runId: record.runId,
      nonce: record.nonce,
      checksDigest: record.checksDigest,
      response: {
        protocol: 1,
        ok: true,
        judge: 'host',
        results: record.request.checks.map((check) => ({
          id: check.id,
          verdict: 'pass',
          evidence: 'read the frame and saw none',
        })),
      },
    });

    const submitted = pixelproof(
      ['judge', 'submit', '--run', record.runId, '--results', '-', '--run-dir', ws.runRoot],
      { input: verdicts },
    );
    assert.equal(submitted.status, 0);
    assert.match(submitted.stdout, /Accepted: semantic-passed/);
    assert.match(submitted.stdout, /PASS\s+s-/);

    const settled = pixelproof(['judge', 'pending', '--run-dir', ws.runRoot]);
    assert.equal(settled.status, 0);

    const report = JSON.parse(await readFile(path.join(directory, 'report.json'), 'utf8'));
    assert.equal(report.accepted, true);
    assert.equal(report.state, 'accepted');
  } finally {
    await removeTemporaryDirectory(ws.root);
  }
});

test('a rejected submission leaves the candidate on disk and exits 1', async () => {
  const ws = await workspace('pixelproof-judge-cli-reject-');
  try {
    assert.equal(pixelproof([
      'verify', '--file', ws.image, '--spec', ws.specPath,
      '--judge', 'host', '--run-dir', ws.runRoot,
    ]).status, 2);

    const directory = await onlyRunDirectory(ws.runRoot);
    const record = JSON.parse(await readFile(path.join(directory, 'judge-request-1.json'), 'utf8'));

    const submitted = pixelproof(
      ['judge', 'submit', '--results', '-', '--run-dir', ws.runRoot],
      {
        input: JSON.stringify({
          runId: record.runId,
          nonce: record.nonce,
          checksDigest: record.checksDigest,
          response: {
            protocol: 1,
            ok: true,
            judge: 'host',
            results: record.request.checks.map((check, index) => ({
              id: check.id,
              verdict: index === 0 ? 'pass' : 'fail',
              evidence: index === 0 ? 'clean' : 'a hand is visible bottom-left',
            })),
          },
        }),
      },
    );

    assert.equal(submitted.status, 1);
    assert.match(submitted.stdout, /Rejected: semantic-failed/);
    assert.match(submitted.stdout, /FAIL\s+s-/);
    assert.equal(await exists(path.join(directory, 'attempt-1.png')), true);
    assert.equal(await exists(path.join(directory, 'report.md')), true);
  } finally {
    await removeTemporaryDirectory(ws.root);
  }
});

test('a refused submission names its reason and leaves the run answerable', async () => {
  const ws = await workspace('pixelproof-judge-cli-refuse-');
  try {
    assert.equal(pixelproof([
      'verify', '--file', ws.image, '--spec', ws.specPath,
      '--judge', 'host', '--run-dir', ws.runRoot,
    ]).status, 2);

    const directory = await onlyRunDirectory(ws.runRoot);
    const record = JSON.parse(await readFile(path.join(directory, 'judge-request-1.json'), 'utf8'));
    const payload = (nonce) => JSON.stringify({
      runId: record.runId,
      nonce,
      checksDigest: record.checksDigest,
      response: {
        protocol: 1,
        ok: true,
        judge: 'host',
        results: record.request.checks.map((check) => ({ id: check.id, verdict: 'pass' })),
      },
    });

    const refused = pixelproof(
      ['judge', 'submit', '--results', '-', '--run-dir', ws.runRoot],
      { input: payload('b'.repeat(64)) },
    );
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /PENDING_NONCE_MISMATCH/);
    assert.match(refused.stderr, /is still open/);

    // Recorded on the run, not only printed (ADR 0009 §3).
    const run = JSON.parse(await readFile(path.join(directory, 'run.json'), 'utf8'));
    assert.ok(run.reasons.some((reason) => reason.code === 'PENDING_NONCE_MISMATCH'));
    assert.equal(run.state, 'pending-judgement');

    // And the same payload with the real nonce still works afterwards.
    const accepted = pixelproof(
      ['judge', 'submit', '--results', '-', '--run-dir', ws.runRoot],
      { input: payload(record.nonce) },
    );
    assert.equal(accepted.status, 0);
  } finally {
    await removeTemporaryDirectory(ws.root);
  }
});

test('judge abandon closes a run as rejected, on the record', async () => {
  const ws = await workspace('pixelproof-judge-cli-abandon-');
  try {
    assert.equal(pixelproof([
      'verify', '--file', ws.image, '--spec', ws.specPath,
      '--judge', 'host', '--run-dir', ws.runRoot,
    ]).status, 2);

    const withoutReason = pixelproof(['judge', 'abandon', '--run-dir', ws.runRoot]);
    assert.equal(withoutReason.status, 1);
    assert.match(withoutReason.stderr, /--reason is required/);

    const closed = pixelproof(['judge', 'abandon', '--reason', 'the host went away', '--run-dir', ws.runRoot]);
    assert.equal(closed.status, 1, 'closing a run is not the same as passing one');
    assert.match(closed.stdout, /closed as rejected: the host went away/);

    const directory = await onlyRunDirectory(ws.runRoot);
    const run = JSON.parse(await readFile(path.join(directory, 'run.json'), 'utf8'));
    assert.equal(run.state, 'rejected');
    assert.equal(run.accepted, false);
    assert.equal(run.outcome.reason, 'judgement-abandoned');
    assert.equal(await exists(path.join(directory, 'report.json')), true);

    assert.equal(pixelproof(['judge', 'pending', '--run-dir', ws.runRoot]).status, 0);
  } finally {
    await removeTemporaryDirectory(ws.root);
  }
});

test('two open runs refuse a bare --run rather than guessing', async () => {
  const ws = await workspace('pixelproof-judge-cli-ambiguous-');
  try {
    for (const _ of [1, 2]) {
      assert.equal(pixelproof([
        'verify', '--file', ws.image, '--spec', ws.specPath,
        '--judge', 'host', '--run-dir', ws.runRoot,
      ]).status, 2);
    }

    const ambiguous = pixelproof(['judge', 'show', '--run-dir', ws.runRoot]);
    assert.equal(ambiguous.status, 1);
    assert.match(ambiguous.stderr, /2 runs are waiting on a host judgement; name one with --run/);
  } finally {
    await removeTemporaryDirectory(ws.root);
  }
});

// --- what --judge refuses, and what it leaves alone ------------------------

test('a mechanical failure ends the run without spending a host round', async () => {
  const ws = await workspace('pixelproof-judge-cli-mechfail-', {
    spec: { ...SPEC, mechanical: { width: 99, height: 99 } },
  });
  try {
    const failed = pixelproof([
      'verify', '--file', ws.image, '--spec', ws.specPath,
      '--judge', 'host', '--run-dir', ws.runRoot,
    ]);

    assert.equal(failed.status, 1, 'not 2: there is no outstanding judgement');
    assert.match(failed.stdout, /Rejected on the mechanical tier/);

    const directory = await onlyRunDirectory(ws.runRoot);
    assert.equal(await exists(path.join(directory, 'judge-request-1.json')), false,
      'no checklist is written for an artifact that is already rejected');

    const run = JSON.parse(await readFile(path.join(directory, 'run.json'), 'utf8'));
    assert.equal(run.state, 'rejected');
    assert.equal(run.outcome.reason, 'mechanical-failed');
  } finally {
    await removeTemporaryDirectory(ws.root);
  }
});

test('--judge refuses what it cannot honestly judge, before doing any work', async () => {
  const ws = await workspace('pixelproof-judge-cli-refusals-');
  try {
    const cases = [
      {
        args: ['--judge', 'nobody'],
        expect: /No judge is registered under "nobody"/,
        why: 'an unknown judge names what is registered rather than guessing',
      },
      {
        // ADR 0021 §10. Refused by name, never silently reduced to one member: a
        // run that quietly dropped a judge would report an artifact as judged by
        // authorities that never saw it.
        args: ['--judge', 'codex,host'],
        expect: /mixed panel, which is specified[\s\S]*but not wired yet/,
        why: 'a mixed panel is specified and not built',
      },
      {
        // ADR 0021 §10 again, from the other side: two subprocess judges is
        // still a panel, and the refusal must not depend on `host` being named.
        args: ['--judge', 'codex,codex-two'],
        expect: /mixed panel, which is specified[\s\S]*but not wired yet/,
        why: 'panel size is what is refused, not the presence of the host',
      },
      {
        args: ['--judge', 'codex,codex'],
        expect: /names "codex" twice/,
        why: 'a judge asked twice is one authority, not a second opinion',
      },
      {
        args: ['--judge', 'host', '--judge-deadline', '3600'],
        expect: /whole number followed by s, m, h or d/,
        why: 'a bare number could be seconds or milliseconds',
      },
      {
        args: ['--judge-deadline', '24h'],
        expect: /--judge-deadline only means something with --judge/,
        why: 'a deadline with nothing to expire is a mistake',
      },
    ];

    for (const { args, expect, why } of cases) {
      const result = pixelproof([
        'verify', '--file', ws.image, '--spec', ws.specPath, '--run-dir', ws.runRoot, ...args,
      ]);
      assert.equal(result.status, 1, why);
      assert.match(result.stderr, expect, why);
    }

    // A vector target has nothing for a vision capability to open, and calling
    // its assertions skipped would report an unverified image as verified.
    const vector = path.join(ws.root, 'icon.svg');
    await writeFile(vector, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>');
    const refused = pixelproof([
      'verify', '--file', vector, '--spec', ws.specPath,
      '--judge', 'host', '--run-dir', ws.runRoot,
    ]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /needs a raster target/);

    const noSemantic = path.join(ws.root, 'mechanical-only.json');
    await writeFile(noSemantic, JSON.stringify({ mechanical: { width: 32 } }));
    const empty = pixelproof([
      'verify', '--file', ws.image, '--spec', noSemantic,
      '--judge', 'host', '--run-dir', ws.runRoot,
    ]);
    assert.equal(empty.status, 1);
    assert.match(empty.stderr, /at least one entry in its "semantic" array/);

    // None of the refusals opened a run.
    assert.equal(await exists(ws.runRoot), false);
  } finally {
    await removeTemporaryDirectory(ws.root);
  }
});

/**
 * Every line the v1 banners carried before ADR 0003's 2026-08-13 amendment,
 * in order, blank lines omitted.
 *
 * The amendment permits *additive* lines only: existing lines may be separated
 * by new ones, but none may be reworded, reordered or dropped. The compat tests
 * hold each whole banner byte for byte, which catches a change — but it catches
 * it identically whether the change was an addition or a silent rewording of an
 * old line, and the fix for a failing byte comparison is to paste in the new
 * output. This list is what makes that shortcut fail: paste in a banner with a
 * reworded historical line and the subsequence check below still refuses it.
 */
const PRE_AMENDMENT_LINES = {
  verify: [
    'pixelproof mechanical verifier',
    'Usage:',
    '  node scripts/verify.mjs --file <path> [--spec <spec.json>] [--json] [--strict]',
    'Options:',
    '  --file <path>       Image to inspect (required)',
    '  --spec <path>       JSON spec containing a mechanical block',
    '  --json              Print a machine-readable result object',
    '  --strict            Treat skipped checks as failures',
    '  -h, --help          Show this help',
  ],
  generate: [
    'pixelproof image generator',
    'Usage:',
    '  node scripts/generate.mjs --prompt "<text>" --out <path> [options]',
    'Options:',
    '  --prompt <text>          Raster generation prompt (required for Codex)',
    '  --out <path>             Target .png or .svg path (required)',
    '  --provider codex|svg     Override provider selection',
    '  --size <WxH>             Desired pixels; verified when --spec is absent',
    '  --spec <file>            Fold a JSON spec into the prompt and verify it; spec dimensions win',
    '  --svg-file <path>        SVG source for the svg provider; otherwise read stdin',
    '  -h, --help               Show this help',
    'Size verification:',
    '  --size without --spec creates a width/height mechanical spec and affects the exit code.',
    '  Codex sizes must have edges divisible by 16, each edge <= 3840, an aspect ratio <= 3:1,',
    '  and a total pixel count from 655360 through 8294400.',
    'Provider selection:',
    '  --provider, then PIXELPROOF_PROVIDER, then .svg output, then Codex on PATH.',
  ],
};

/** Which of `wanted` is missing from `lines`, or out of order. */
function firstOutOfOrder(lines, wanted) {
  let cursor = 0;
  for (const line of wanted) {
    const found = lines.indexOf(line, cursor);
    if (found === -1) return line;
    cursor = found + 1;
  }
  return null;
}

test('without --judge nothing changes: no run directory, and the v1 banners only grew', async () => {
  const ws = await workspace('pixelproof-judge-cli-untouched-');
  try {
    // Run from a scratch working directory, so "no run root was created" is a
    // fact about this invocation rather than about whether someone happened to
    // leave a `.pixelproof/` in the checkout.
    const plain = pixelproof(['verify', '--file', ws.image, '--spec', ws.specPath], { cwd: ws.root });
    assert.equal(plain.status, 0);
    assert.equal(plain.stdout.includes('Pending host judgement'), false);
    assert.equal(await exists(path.join(ws.root, '.pixelproof')), false,
      'a run without --judge must not create a run root');

    // ADR 0003 as amended on 2026-08-13: a banner may gain lines documenting a
    // new flag, and may not lose or reword the ones it had.
    for (const [command, usage] of [['verify', VERIFY_USAGE], ['generate', GENERATE_USAGE]]) {
      const help = pixelproof([command, '--help']);
      assert.equal(help.status, 0);
      assert.equal(help.stdout, `${usage}\n`);

      const lines = usage.split('\n').map((line) => line.trimEnd()).filter((line) => line !== '');
      const lost = firstOutOfOrder(lines, PRE_AMENDMENT_LINES[command]);
      assert.equal(lost, null,
        `${command}'s banner reworded, reordered or dropped a pre-amendment line: ${JSON.stringify(lost)}`);

      // The point of the amendment: the flags are findable by the only route a
      // user would try.
      for (const flag of ['--judge host', '--judge-deadline', '--run-dir']) {
        assert.ok(lines.some((line) => line.trimStart().startsWith(flag)),
          `${command} --help must list ${flag} in its options`);
      }
      // ADR 0020's flag, added under the same amendment and on the generator
      // only: `verify` has no provider call to repeat, so a bound there would
      // name an attempt the command could never spend.
      const listsRetakes = lines.some((line) => line.trimStart().startsWith('--retakes'));
      assert.equal(listsRetakes, command === 'generate',
        `${command} --help must ${command === 'generate' ? 'list' : 'not list'} --retakes`);
      // Matched across a line wrap: verify's banner is narrower than
      // generate's, so the sentence breaks in a different place.
      assert.match(usage, /exits 2: an outstanding judgement/);
      assert.match(usage, /never a\s+pass\./);
    }

    // The top-level banner carries them too, since it is where a reader who has
    // not yet picked a command looks.
    const top = pixelproof(['--help']);
    assert.match(top.stdout, /--judge host/);
    assert.match(top.stdout, /^ {2}judge {2,}List, show, answer or close/m);
  } finally {
    await removeTemporaryDirectory(ws.root);
  }
});

// --- doctor ---------------------------------------------------------------

test('doctor --run-dir scans the run root it was given, not the default one', async () => {
  const ws = await workspace('pixelproof-judge-cli-doctor-root-');
  try {
    assert.equal(pixelproof([
      'verify', '--file', ws.image, '--spec', ws.specPath,
      '--judge', 'host', '--run-dir', ws.runRoot,
    ]).status, 2);

    // The real scan, not the probe seam: this is what a user whose runs live
    // outside the working directory actually runs. Executed from a scratch cwd
    // so the default root is empty and cannot supply the answer by accident.
    const pointed = pixelproof(['doctor', '--run-dir', ws.runRoot], { cwd: ws.root });
    assert.match(pointed.stdout, /judgements: {2,}1 pending host judgement \(0 expired\)/);

    const unpointed = pixelproof(['doctor'], { cwd: ws.root });
    assert.match(unpointed.stdout, /judgements: {2,}none pending/,
      'without --run-dir the default root is scanned, and it is empty here');

    // PIXELPROOF_RUN_ROOT reaches the same place, so the flag and the variable
    // do not disagree about where evidence lives.
    const viaEnvironment = pixelproof(['doctor'], {
      cwd: ws.root,
      env: { ...process.env, PIXELPROOF_RUN_ROOT: ws.runRoot },
    });
    assert.match(viaEnvironment.stdout, /judgements: {2,}1 pending host judgement/);
  } finally {
    await removeTemporaryDirectory(ws.root);
  }
});

test('doctor reports outstanding judgements, and says when it could not look', async () => {
  const probes = (pending, stalled = async () => []) => ({
    providers: async () => [{ id: 'svg', kinds: ['vector'], available: true }],
    decoder: async () => ({ sharp: {} }),
    pending,
    // Injected even when it is empty: without it doctor would fall back to
    // scanning the real run root, and a test that reads the checkout's own
    // `.pixelproof/` fails for reasons that have nothing to do with the code.
    stalled,
  });

  const none = capture();
  assert.equal(await doctorCommand({ argv: [], probes: { ...probes(async () => []), output: none.output } }), 0);
  assert.match(none.stdout, /judgements: {2,}none pending/);

  const some = capture();
  const future = new Date(Date.now() + 3_600_000).toISOString();
  const past = new Date(Date.now() - 3_600_000).toISOString();
  await doctorCommand({
    argv: [],
    probes: {
      ...probes(async () => [
        { record: { expiresAt: future }, error: null },
        { record: { expiresAt: past }, error: null },
        { record: null, error: { code: 'PENDING_NOT_FOUND', message: 'gone' } },
      ]),
      output: some.output,
    },
  });
  assert.match(some.stdout, /3 pending host judgements \(1 expired, 1 unreadable\)/);
  assert.match(some.stdout, /pixelproof judge pending/);

  // A failed scan must not read as "nothing outstanding".
  const broken = capture();
  await doctorCommand({
    argv: [],
    probes: {
      ...probes(async () => { throw new Error('run root unreadable'); }),
      output: broken.output,
    },
  });
  assert.match(broken.stdout, /judgements: {2,}could not scan \(run root unreadable\)/);

  const asJson = capture();
  await doctorCommand({
    argv: ['--json'],
    probes: { ...probes(async () => [{ record: { expiresAt: past }, error: null }]), output: asJson.output },
  });
  const report = JSON.parse(asJson.stdout);
  assert.deepEqual(report.pending, { total: 1, expired: 1, unreadable: 0, stalled: 0, error: null });
});

test('doctor counts a run left open between retake attempts (ADR 0020)', async () => {
  // The orphan ADR 0020 creates: a run rejected on one attempt, with the bound
  // unspent, that nobody retook and nobody abandoned. Nothing is pending on it,
  // so `judge pending` cannot see it — which is exactly why this line has to.
  const probes = (pending, stalled) => ({
    providers: async () => [{ id: 'svg', kinds: ['vector'], available: true }],
    decoder: async () => ({ sharp: {} }),
    pending,
    stalled,
  });

  const orphaned = capture();
  await doctorCommand({
    argv: [],
    probes: {
      ...probes(async () => [], async () => [{ runId: '2026-08-14T09-00-00Z-a1b2c3d4' }]),
      output: orphaned.output,
    },
  });
  assert.match(orphaned.stdout, /judgements: {2,}none pending; 1 run open between attempts/);
  assert.match(orphaned.stdout, /pixelproof retake --run <id>/,
    'the line must say what to do about it, or it is a number nobody acts on');

  // It is reported alongside a pending count rather than instead of one.
  const both = capture();
  await doctorCommand({
    argv: [],
    probes: {
      ...probes(
        async () => [{ record: { expiresAt: new Date(Date.now() + 3_600_000).toISOString() }, error: null }],
        async () => [{ runId: '2026-08-14T09-00-00Z-a1b2c3d4' }, { runId: '2026-08-14T09-00-01Z-a1b2c3d5' }],
      ),
      output: both.output,
    },
  });
  assert.match(both.stdout, /1 pending host judgement \(0 expired\)/);
  assert.match(both.stdout, /2 runs open between attempts/);

  // A failed open-run scan is "I could not look", not "none".
  const broken = capture();
  await doctorCommand({
    argv: [],
    probes: {
      ...probes(async () => [], async () => { throw new Error('run root unreadable'); }),
      output: broken.output,
    },
  });
  assert.match(broken.stdout, /judgements: {2,}could not scan \(run root unreadable\)/);
  assert.doesNotMatch(broken.stdout, /none pending/,
    'a scan that failed must never read as nothing outstanding');

  const asJson = capture();
  await doctorCommand({
    argv: ['--json'],
    probes: {
      ...probes(async () => [], async () => [{ runId: '2026-08-14T09-00-00Z-a1b2c3d4' }]),
      output: asJson.output,
    },
  });
  assert.deepEqual(JSON.parse(asJson.stdout).pending, {
    total: 0, expired: 0, unreadable: 0, stalled: 1, error: null,
  });
});
