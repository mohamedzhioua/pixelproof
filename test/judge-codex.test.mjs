import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { assignCheckIds } from '../core/contracts/check-id.mjs';
import { VERDICTS } from '../core/contracts/judge.mjs';
import {
  CODEX_ENV_ALLOWLIST,
  JUDGE_PROMPT,
  buildJudgeArgs,
  classifyDiagnostics,
  detect,
  judge,
  judgeResponseSchema,
  manifest,
  resolveCodexCommand,
} from '../judges/codex.mjs';

/**
 * Nothing here runs the real Codex CLI and nothing here touches the network.
 *
 * The stand-in is a plain Node script invoked through `process.execPath`, exactly
 * as `test/adapter-subprocess.test.mjs` does it: the executable is always a real
 * `.exe`, the script is just an argument, and the Windows `.cmd`/PATHEXT
 * resolution problem never arises. The adapter's `command`/`args` options are the
 * seam — `args` are prepended to the codex argv, so the fake receives its mode as
 * `argv[2]` and then the whole real argument list the adapter built.
 *
 * The fake also copies what it saw (argv, output schema, the request it got on
 * stdin) to a sidecar file outside the adapter's scratch directory, which is how
 * the flags verified against `codex exec --help` are pinned by a test rather than
 * by a comment.
 */
const FAKE_CODEX = `
import { readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const mode = argv[0];
const sidecar = argv[1];
const valueOf = (name) => {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1];
};
const replyFile = valueOf('-o');
const schemaFile = valueOf('--output-schema');
const image = valueOf('-i');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  // The real CLI puts its transcript on stderr and the final message on stdout.
  process.stderr.write('OpenAI Codex v0.0.0-fake\\n');
  process.stderr.write('sandbox: ' + String(valueOf('--sandbox')) + '\\n');

  const request = JSON.parse(input.trim());
  const schema = JSON.parse(readFileSync(schemaFile, 'utf8'));
  writeFileSync(sidecar, JSON.stringify({ argv: argv.slice(2), schema, request }));

  const ids = request.checks.map((check) => check.id);
  const results = ids.map((id, index) => ({
    id,
    verdict: ['pass', 'fail', 'unsure'][index % 3],
    confidence: 0.9,
    evidence: 'observed in ' + String(image),
  }));
  const reply = { protocol: 1, ok: true, judge: 'not-the-judges-business-to-name', results };

  const emit = (payload, channel) => {
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
    if (channel === 'file') writeFileSync(replyFile, text);
    else process.stdout.write(text + '\\n');
  };
  const withResults = (next) => ({ ...reply, results: next });

  switch (mode) {
    case 'well-formed':
      emit(reply, 'stdout');
      return;
    case 'via-file':
      // Pretty-printed, and only in the file: the transcript on stdout carries
      // no JSON at all, which is the case the file channel exists for.
      process.stdout.write('thinking about the picture\\n');
      emit(JSON.stringify(reply, null, 2), 'file');
      process.stdout.write('done\\n');
      return;
    case 'wrong-ids':
      emit(withResults(results.map((result, index) => ({
        ...result,
        id: 's-' + String(index + 1).padStart(10, 'a'),
      }))), 'stdout');
      return;
    case 'missing':
      emit(withResults(results.slice(1)), 'stdout');
      return;
    case 'duplicate':
      emit(withResults([results[0], ...results]), 'stdout');
      return;
    case 'bad-confidence':
      emit(withResults(results.map((result, index) => (
        index === 0 ? { ...result, confidence: 1.5 } : result
      ))), 'stdout');
      return;
    case 'summary-only':
      emit({ protocol: 1, ok: true, judge: 'codex', summary: 'Looks good to me overall.' }, 'stdout');
      return;
    case 'not-json':
      process.stdout.write('The image looks fine to me, honestly.\\n');
      return;
    case 'hang':
      setTimeout(() => { process.stdout.write('too late\\n'); }, 60000);
      return;
    case 'auth-failure':
      process.stderr.write('ERROR: unexpected status 401 Unauthorized: Missing bearer or basic '
        + 'authentication in header, url: https://api.openai.com/v1/responses\\n');
      process.exitCode = 1;
      return;
    case 'rate-limited':
      process.stderr.write('ERROR: unexpected status 429 Too Many Requests: rate limit exceeded\\n');
      process.exitCode = 1;
      return;
    case 'ok-false-stdout':
      emit({
        protocol: 1,
        ok: false,
        error: { code: 'CONTENT_REFUSED', message: 'the model declined to judge', retryable: false },
      }, 'stdout');
      return;
    case 'ok-false-file':
      emit({
        protocol: 1,
        ok: false,
        error: { code: 'CONTENT_REFUSED', message: 'the model declined to judge', retryable: false },
      }, 'file');
      return;
    case 'nonzero-exit':
      // A perfect reply, and a failed process. The reply must not be believed.
      emit(reply, 'file');
      process.stderr.write('ERROR: something the taxonomy has no name for\\n');
      process.exitCode = 3;
      return;
    default:
      process.stderr.write('unknown fake mode ' + String(mode) + '\\n');
      process.exitCode = 9;
  }
});
`;

const ASSERTIONS = Object.freeze([
  'A single solid red circle is centred on the canvas',
  'Zero text, letters, numbers or watermarks appear anywhere',
  'A blue square is visible in the lower-left corner',
]);

const roots = [];

async function workspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pixelproof-judge-codex-test-'));
  roots.push(root);
  return root;
}

test.after(async () => {
  for (const root of roots) {
    await rm(root, { recursive: true, force: true });
  }
});

/** A file that exists and ends in .png; no byte of it is ever decoded here. */
async function artifactFile(root) {
  const file = path.join(root, 'attempt-1.png');
  await writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return file;
}

function requestFor(file, assertions = ASSERTIONS) {
  return {
    protocol: 1,
    file,
    context: 'Flat vector mark on seamless white',
    checks: assignCheckIds(assertions),
  };
}

/**
 * A fake CLI in `mode`, plus the request that points at a real file.
 *
 * `env` is pinned rather than inherited so a developer's own
 * `PIXELPROOF_JUDGE_*` settings cannot change what these tests assert.
 */
async function harness(mode, { assertions = ASSERTIONS, timeoutMs = 20_000 } = {}) {
  const root = await workspace();
  const fake = path.join(root, 'fake-codex.mjs');
  const sidecar = path.join(root, 'seen.json');
  await writeFile(fake, FAKE_CODEX, 'utf8');
  const file = await artifactFile(root);

  return {
    root,
    sidecar,
    request: requestFor(file, assertions),
    artifact: file,
    options: {
      command: process.execPath,
      args: [fake, mode, sidecar],
      timeoutMs,
      env: {
        ...process.env,
        PIXELPROOF_JUDGE_TIMEOUT_MS: '',
        PIXELPROOF_JUDGE_CODEX_MODEL: '',
        PIXELPROOF_JUDGE_CODEX_EFFORT: '',
      },
    },
    seen: async () => JSON.parse(await readFile(sidecar, 'utf8')),
  };
}

test('a well-formed verdict set comes back paired to the requested checks', async () => {
  const { request, options } = await harness('well-formed');

  const response = await judge(request, options);

  assert.equal(response.protocol, 1);
  assert.equal(response.ok, true);
  assert.equal(response.judge, 'codex', 'the adapter names the judge, not the model');
  assert.deepEqual(
    response.results.map((result) => result.id),
    request.checks.map((check) => check.id),
  );
  assert.deepEqual(response.results.map((result) => result.verdict), ['pass', 'fail', 'unsure']);
  assert.equal(response.results[0].confidence, 0.9);
  assert.match(response.results[0].evidence, /observed in .*attempt-1\.png/u);
  assert.equal(response.meta.replyChannel, 'stdout');
  assert.equal(response.meta.exitCode, 0);
  assert.ok(response.durationMs >= 0);
});

test('the request crosses on stdin verbatim, with the verified flags around it', async () => {
  const { request, artifact, options, seen } = await harness('well-formed');

  await judge(request, options);
  const observed = await seen();

  // Exactly the protocol-1 request, with only the artifact path absolutised.
  assert.deepEqual(observed.request, { ...request, file: artifact });

  // Flags read off `codex exec --help` (codex-cli 0.147.0) and confirmed against
  // the real CLI. A vendor rename must fail here, not in production.
  assert.equal(observed.argv[0], 'exec');
  for (const [flag, value] of [
    ['--sandbox', 'read-only'],
    ['--color', 'never'],
    ['-i', artifact],
  ]) {
    assert.equal(observed.argv[observed.argv.indexOf(flag) + 1], value, `${flag} value`);
  }
  assert.ok(observed.argv.includes('--skip-git-repo-check'));
  assert.ok(observed.argv.includes('--ephemeral'));
  assert.ok(observed.argv.includes('--output-schema'));
  assert.ok(observed.argv.includes('-o'));
  assert.equal(observed.argv.at(-1), JUDGE_PROMPT, 'the prompt is the trailing positional');
  assert.ok(!observed.argv.includes('-m'), 'no model is pinned unless one is asked for');

  // The output schema pins the answer to the ids that were asked.
  const ids = request.checks.map((check) => check.id);
  assert.deepEqual(observed.schema.properties.results.items.properties.id.enum, ids);
  assert.deepEqual(observed.schema.properties.results.items.properties.verdict.enum, [...VERDICTS]);
});

test('a reply that only reaches the output file is still read', async () => {
  const { request, options } = await harness('via-file');

  const response = await judge(request, options);

  assert.equal(response.ok, true);
  assert.equal(response.meta.replyChannel, 'output-last-message');
  assert.equal(response.results.length, 3);
});

test('answering checks nobody asked about is rejected', async () => {
  const { request, options } = await harness('wrong-ids');

  await assert.rejects(() => judge(request, options), (thrown) => {
    assert.equal(thrown.name, 'AdapterError');
    assert.equal(thrown.code, 'INTERNAL');
    assert.match(thrown.message, /does not answer exactly the checks that were asked/u);
    assert.equal(thrown.details.violation.missing.length, 3);
    assert.equal(thrown.details.violation.unexpected.length, 3);
    assert.equal(thrown.results, undefined, 'a rejected reply carries no results');
    return true;
  });
});

test('a missing verdict is a protocol violation, never a pass', async () => {
  const { request, options } = await harness('missing');

  await assert.rejects(() => judge(request, options), (thrown) => {
    assert.equal(thrown.code, 'INTERNAL');
    assert.match(thrown.message, /does not answer exactly the checks that were asked/u);
    assert.deepEqual(thrown.details.violation.missing, [request.checks[0].id]);
    assert.deepEqual(thrown.details.violation.unexpected, []);
    return true;
  });
});

test('a duplicated verdict for one check is rejected', async () => {
  const { request, options } = await harness('duplicate');

  await assert.rejects(() => judge(request, options), (thrown) => {
    assert.equal(thrown.code, 'INTERNAL');
    assert.match(thrown.message, /duplicate results for one check/u);
    assert.equal(thrown.details.violation.id, request.checks[0].id);
    return true;
  });
});

test('a confidence outside [0, 1] is rejected', async () => {
  const { request, options } = await harness('bad-confidence');

  await assert.rejects(() => judge(request, options), (thrown) => {
    assert.equal(thrown.code, 'INTERNAL');
    assert.match(thrown.message, /confidence must be a number in \[0, 1\]/u);
    assert.equal(thrown.details.violation.confidence, 1.5);
    return true;
  });
});

test('a summary opinion with no per-assertion verdicts is a violation, not a pass', async () => {
  const { request, options } = await harness('summary-only');

  await assert.rejects(() => judge(request, options), (thrown) => {
    assert.equal(thrown.code, 'INTERNAL');
    assert.match(thrown.message, /results must be an array/u);
    return true;
  });
});

test('a non-JSON reply maps to INTERNAL and keeps the diagnostics', async () => {
  const { request, options } = await harness('not-json');

  await assert.rejects(() => judge(request, options), (thrown) => {
    assert.equal(thrown.code, 'INTERNAL');
    assert.match(thrown.message, /no parseable JSON reply/u);
    assert.match(thrown.details.stderr, /OpenAI Codex v0\.0\.0-fake/u);
    return true;
  });
});

test('a judge that never answers is killed by the deadline and maps to TIMEOUT', async () => {
  const { request, options } = await harness('hang', { timeoutMs: 800 });

  const started = Date.now();
  await assert.rejects(() => judge(request, options), (thrown) => {
    assert.equal(thrown.code, 'TIMEOUT');
    assert.equal(thrown.retryable, true);
    assert.equal(thrown.details.timeoutMs, 800);
    return true;
  });
  assert.ok(Date.now() - started < 20_000, 'the deadline must actually end the wait');
});

test('an authentication failure is named as one, not reported as a bad judgement', async () => {
  const { request, options } = await harness('auth-failure');

  await assert.rejects(() => judge(request, options), (thrown) => {
    assert.equal(thrown.code, 'AUTH_REQUIRED');
    assert.equal(thrown.details.exitCode, 1);
    assert.match(thrown.details.stderr, /401 Unauthorized/u);
    return true;
  });
});

test('a rate-limited run is retryable and named', async () => {
  const { request, options } = await harness('rate-limited');

  await assert.rejects(() => judge(request, options), (thrown) => {
    assert.equal(thrown.code, 'RATE_LIMITED');
    assert.equal(thrown.retryable, true);
    return true;
  });
});

test('an ok:false payload never resolves, on either channel', async () => {
  for (const mode of ['ok-false-stdout', 'ok-false-file']) {
    const { request, options } = await harness(mode);

    await assert.rejects(() => judge(request, options), (thrown) => {
      assert.equal(thrown.code, 'CONTENT_REFUSED', mode);
      assert.match(thrown.message, /declined to judge/u);
      return true;
    });
  }
});

test('a non-zero exit is a failure even when the reply is perfect', async () => {
  const { request, options } = await harness('nonzero-exit');

  await assert.rejects(() => judge(request, options), (thrown) => {
    assert.equal(thrown.code, 'INTERNAL');
    assert.match(thrown.message, /exited with code 3/u);
    assert.equal(thrown.results, undefined);
    return true;
  });
});

test('a malformed request is refused before anything is spawned', async () => {
  const { request, options } = await harness('well-formed');

  await assert.rejects(() => judge({ ...request, protocol: 2 }, options), { code: 'INVALID_REQUEST' });
  await assert.rejects(() => judge({ ...request, checks: [] }, options), { code: 'INVALID_REQUEST' });
  await assert.rejects(
    () => judge({ ...request, file: path.join(path.dirname(request.file), 'absent.png') }, options),
    (thrown) => {
      assert.equal(thrown.code, 'INVALID_REQUEST');
      assert.match(thrown.message, /cannot open the artifact/u);
      return true;
    },
  );
});

test('detect misses when nothing named codex is on PATH', async () => {
  const root = await workspace();

  const detected = detect({ env: { PATH: root } });

  assert.equal(detected.available, false);
  assert.match(detected.reason, /not found on PATH/u);
  assert.equal(resolveCodexCommand({ env: { PATH: root } }), null);
});

test('detect finds a plain executable on PATH and claims nothing about login', async () => {
  const root = await workspace();
  // Both names, so the assertion holds on Windows and on Unix without the test
  // pretending to be a platform it is not.
  await writeFile(path.join(root, 'codex.exe'), '');
  await writeFile(path.join(root, 'codex'), '');

  const detected = detect({ env: { PATH: root } });

  assert.equal(detected.available, true);
  assert.equal(detected.reason, null);
  assert.equal(
    manifest.auth.state,
    'unknown',
    'being on PATH is availability; login state is never claimed (ADR 0016)',
  );
  assert.match(manifest.auth.detail, /cannot be checked without a network or paid call/u);
});

test('an unresolvable CLI is PROVIDER_UNAVAILABLE, not a silent skip', async () => {
  const root = await workspace();
  const file = await artifactFile(root);

  await assert.rejects(
    () => judge(requestFor(file), { env: { PATH: root } }),
    (thrown) => {
      assert.equal(thrown.code, 'PROVIDER_UNAVAILABLE');
      assert.equal(thrown.retryable, false);
      assert.ok(thrown.details.remediation.some((step) => /npm install -g @openai\/codex/u.test(step)));
      return true;
    },
  );
});

test('the manifest declares a judge, not a provider, and no secret is forwarded', () => {
  assert.equal(manifest.protocol, 1);
  assert.equal(manifest.id, 'codex');
  assert.equal(manifest.role, 'judge');
  assert.deepEqual(manifest.kinds, ['raster']);
  assert.equal(manifest.capabilities.vision, true);
  assert.deepEqual(manifest.capabilities.verdicts, VERDICTS);
  assert.equal(manifest.capabilities.maxChecks, null, 'undeclared is not infinite');
  assert.equal(Object.isFrozen(manifest), true);

  assert.ok(
    !CODEX_ENV_ALLOWLIST.includes('OPENAI_API_KEY'),
    'a secret must be named at the call site, never forwarded by default',
  );
  assert.ok(CODEX_ENV_ALLOWLIST.includes('CODEX_HOME'));
});

test('the output schema restates the contract rather than duplicating its vocabulary', () => {
  const ids = assignCheckIds(ASSERTIONS).map((check) => check.id);
  const schema = judgeResponseSchema(ids);

  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['protocol', 'ok', 'results']);
  assert.deepEqual(schema.properties.protocol.enum, [1]);
  assert.equal(
    Object.hasOwn(schema.properties, 'judge'),
    false,
    'the model does not get to name which judge answered',
  );

  const item = schema.properties.results.items;
  assert.equal(item.additionalProperties, false);
  assert.deepEqual(
    [...item.required].sort(),
    ['confidence', 'evidence', 'id', 'verdict'],
    'strict structured output requires every property it declares',
  );
  assert.deepEqual(item.properties.verdict.enum, [...VERDICTS]);
  assert.deepEqual(item.properties.id.enum, ids);
});

test('diagnostics are classified in priority order and never guessed', () => {
  assert.equal(classifyDiagnostics('401 Unauthorized: Missing bearer'), 'AUTH_REQUIRED');
  assert.equal(classifyDiagnostics('please run codex login'), 'AUTH_REQUIRED');
  assert.equal(classifyDiagnostics('429 Too Many Requests'), 'RATE_LIMITED');
  assert.equal(classifyDiagnostics('usage limit reached for this account'), 'RATE_LIMITED');
  assert.equal(classifyDiagnostics('blocked by our content policy'), 'CONTENT_REFUSED');
  assert.equal(classifyDiagnostics('some unrecognised vendor noise'), 'INTERNAL');
  assert.equal(classifyDiagnostics(''), 'INTERNAL');
  assert.equal(classifyDiagnostics(undefined), 'INTERNAL');
});

test('buildJudgeArgs pins a model and effort only when asked', () => {
  const base = buildJudgeArgs({
    artifact: '/tmp/a.png',
    schemaFile: '/tmp/s.json',
    replyFile: '/tmp/r.json',
    cwd: '/tmp',
  });
  assert.ok(!base.includes('-m'));
  assert.ok(!base.includes('-c'));

  const pinned = buildJudgeArgs({
    artifact: '/tmp/a.png',
    schemaFile: '/tmp/s.json',
    replyFile: '/tmp/r.json',
    cwd: '/tmp',
    model: 'gpt-5.6-sol',
    effort: 'xhigh',
  });
  assert.equal(pinned[pinned.indexOf('-m') + 1], 'gpt-5.6-sol');
  assert.equal(pinned[pinned.indexOf('-c') + 1], 'model_reasoning_effort=xhigh');
});
