import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildEnvironment,
  describe as describeAdapter,
  exchange,
  extractReply,
  run,
} from '../core/adapters/subprocess.mjs';
import { MAX_RESPONSE_BYTES } from '../core/contracts/provider.mjs';

/**
 * Fake adapters are plain Node scripts invoked through `process.execPath`. That
 * keeps the tests hermetic (no vendor CLI, no network) and sidesteps the Windows
 * `.cmd`/PATHEXT resolution problem entirely, because the executable is always a
 * real `.exe` and the script is just an argument.
 */
const roots = [];

async function workspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pixelproof-subprocess-'));
  roots.push(root);
  return root;
}

test.after(async () => {
  for (const root of roots) {
    await rm(root, { recursive: true, force: true });
  }
});

async function fakeAdapter(source, name = 'adapter.mjs') {
  const root = await workspace();
  const file = path.join(root, name);
  await writeFile(file, source, 'utf8');
  return { root, file };
}

function configFor(file, overrides = {}) {
  return { command: process.execPath, args: [file], timeoutMs: 10_000, ...overrides };
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

test('a successful round trip returns the adapter reply', async () => {
  const { file } = await fakeAdapter(`
    let input = '';
    process.stdin.on('data', (chunk) => { input += chunk; });
    process.stdin.on('end', () => {
      const request = JSON.parse(input);
      process.stdout.write(JSON.stringify({
        protocol: 1,
        ok: true,
        file: request.out,
        echoed: request.prompt,
      }) + '\\n');
    });
  `);

  const result = await run(configFor(file), { kind: 'raster', prompt: 'a cube', out: 'out.png' });
  assert.equal(result.response.ok, true);
  assert.equal(result.response.echoed, 'a cube');
  assert.equal(result.response.file, 'out.png');
  assert.equal(result.exitCode, 0);
  assert.ok(result.durationMs >= 0);
});

test('describe returns a validated manifest for both reply envelopes', async () => {
  const manifest = {
    protocol: 1,
    id: 'demo-raster',
    kinds: ['raster'],
    capabilities: { maxWidth: 2048, seed: true },
  };

  const inline = await fakeAdapter(`
    process.stdin.resume();
    process.stdin.on('end', () => {
      process.stdout.write(JSON.stringify(${JSON.stringify(manifest)}) + '\\n');
    });
  `);
  const wrapped = await fakeAdapter(`
    process.stdin.resume();
    process.stdin.on('end', () => {
      process.stdout.write(JSON.stringify({ protocol: 1, ok: true, manifest: ${JSON.stringify(manifest)} }) + '\\n');
    });
  `);

  for (const adapter of [inline, wrapped]) {
    const described = await describeAdapter(configFor(adapter.file));
    assert.equal(described.id, 'demo-raster');
    assert.deepEqual(described.kinds, ['raster']);
    assert.equal(described.capabilities.maxWidth, 2048);
    assert.equal(described.capabilities.seed, true);
    assert.equal(described.capabilities.minWidth, null);
  }
});

test('a well-formed failure payload passes its own code through', async () => {
  const { file } = await fakeAdapter(`
    process.stdin.resume();
    process.stdin.on('end', () => {
      process.stdout.write(JSON.stringify({
        protocol: 1,
        ok: false,
        error: { code: 'AUTH_REQUIRED', message: 'sign in first', retryable: false },
      }) + '\\n');
      process.exitCode = 4;
    });
  `);

  await assert.rejects(
    () => run(configFor(file), { kind: 'raster', prompt: 'x', out: 'o.png' }),
    (thrown) => {
      assert.equal(thrown.code, 'AUTH_REQUIRED');
      assert.equal(thrown.message, 'sign in first');
      assert.equal(thrown.retryable, false);
      assert.equal(thrown.details.exitCode, 4);
      return true;
    },
  );
});

test('an unknown reported code is narrowed to INTERNAL', async () => {
  const { file } = await fakeAdapter(`
    process.stdin.resume();
    process.stdin.on('end', () => {
      process.stdout.write(JSON.stringify({
        protocol: 1,
        ok: false,
        error: { code: 'QUOTA_EXPLODED', message: 'vendor specific' },
      }) + '\\n');
    });
  `);

  await assert.rejects(() => run(configFor(file), { prompt: 'x' }), (thrown) => {
    assert.equal(thrown.code, 'INTERNAL');
    assert.equal(thrown.message, 'vendor specific');
    assert.equal(thrown.details.reported.reportedCode, 'QUOTA_EXPLODED');
    return true;
  });
});

test('a missing executable maps to PROVIDER_UNAVAILABLE', async () => {
  const root = await workspace();
  const missing = path.join(root, 'does-not-exist-adapter.exe');

  await assert.rejects(() => run({ command: missing, args: [], timeoutMs: 5_000 }, { prompt: 'x' }), (thrown) => {
    assert.equal(thrown.name, 'AdapterError');
    assert.equal(thrown.code, 'PROVIDER_UNAVAILABLE');
    assert.equal(thrown.details.code, 'ENOENT');
    return true;
  });
});

test('noise before and after the reply does not break parsing', async () => {
  const { file } = await fakeAdapter(`
    process.stdout.write('booting adapter\\n');
    process.stdout.write('progress 50%\\n');
    process.stderr.write('a warning nobody asked for\\n');
    process.stdin.resume();
    process.stdin.on('end', () => {
      process.stdout.write(JSON.stringify({ protocol: 1, ok: true, file: 'x.png' }) + '\\n');
      process.stdout.write('done, cleaning up\\n');
      process.stdout.write('{"not":"a protocol reply"}\\n');
    });
  `);

  const result = await run(configFor(file), { prompt: 'x' });
  assert.equal(result.response.ok, true);
  assert.equal(result.response.file, 'x.png');
  assert.match(result.stderr, /a warning nobody asked for/u);
});

test('an adapter that emits no reply maps to INTERNAL', async () => {
  const { file } = await fakeAdapter(`
    process.stdin.resume();
    process.stdin.on('end', () => {
      process.stdout.write('all done, no protocol reply here\\n');
      process.stderr.write('stderr diagnostics\\n');
      process.exitCode = 0;
    });
  `);

  await assert.rejects(() => run(configFor(file), { prompt: 'x' }), (thrown) => {
    assert.equal(thrown.code, 'INTERNAL');
    assert.match(thrown.message, /no parseable JSON reply/u);
    assert.match(thrown.details.stderr, /stderr diagnostics/u);
    return true;
  });
});

test('a mismatched protocol version is a protocol violation, not a pass-through', async () => {
  const { file } = await fakeAdapter(`
    process.stdin.resume();
    process.stdin.on('end', () => {
      process.stdout.write(JSON.stringify({ protocol: 99, ok: true, file: 'x.png' }) + '\\n');
    });
  `);

  await assert.rejects(() => run(configFor(file), { prompt: 'x' }), (thrown) => {
    assert.equal(thrown.code, 'INTERNAL');
    assert.match(thrown.message, /protocol 99/u);
    return true;
  });
});

test('an adapter flooding stdout is killed and reported as INTERNAL', async () => {
  const { file } = await fakeAdapter(`
    const line = 'x'.repeat(64 * 1024) + '\\n';
    function flood() {
      // Deliberately unbounded: the runner must stop this, not the adapter.
      while (process.stdout.write(line)) { /* keep going */ }
      process.stdout.once('drain', flood);
    }
    flood();
    setTimeout(() => {}, 60_000);
  `);

  const started = Date.now();
  await assert.rejects(
    () => run(configFor(file, { maxResponseBytes: 128 * 1024, timeoutMs: 30_000 }), { prompt: 'x' }),
    (thrown) => {
      assert.equal(thrown.code, 'INTERNAL');
      assert.match(thrown.message, /more than 131072 bytes/u);
      return true;
    },
  );
  // Proof it was the cap and not the deadline that ended the run.
  assert.ok(Date.now() - started < 25_000, 'flood should be cut off well before the deadline');
});

test('the stderr tail is bounded and keeps the end of the stream', async () => {
  const { file } = await fakeAdapter(`
    for (let index = 0; index < 200; index += 1) {
      process.stderr.write('noise-' + index + '-' + 'y'.repeat(200) + '\\n');
    }
    process.stdin.resume();
    process.stdin.on('end', () => {
      process.stderr.write('LAST-LINE-MARKER\\n');
      process.stdout.write(JSON.stringify({ protocol: 1, ok: true, file: 'x.png' }) + '\\n');
    });
  `);

  const result = await run(configFor(file, { maxLogBytes: 4096 }), { prompt: 'x' });
  assert.ok(Buffer.byteLength(result.stderr, 'utf8') <= 4096);
  assert.match(result.stderr, /LAST-LINE-MARKER/u);
  assert.doesNotMatch(result.stderr, /noise-0-/u);
});

test('an adapter that hangs is killed by the deadline and mapped to TIMEOUT', async () => {
  const { file } = await fakeAdapter(`
    process.stdin.resume();
    setTimeout(() => { process.stdout.write('too late\\n'); }, 60_000);
  `);

  const started = Date.now();
  await assert.rejects(() => run(configFor(file, { timeoutMs: 700 }), { prompt: 'x' }), (thrown) => {
    assert.equal(thrown.code, 'TIMEOUT');
    assert.equal(thrown.retryable, true);
    assert.equal(thrown.details.timeoutMs, 700);
    return true;
  });
  assert.ok(Date.now() - started < 20_000, 'the deadline must actually end the wait');
});

test('the deadline kills the whole process tree, not just the direct child', async () => {
  const root = await workspace();
  const marker = path.join(root, 'grandchild-survived.txt');
  const grandchild = path.join(root, 'grandchild.mjs');
  const parent = path.join(root, 'parent.mjs');

  // The grandchild only writes its marker after a delay far longer than the
  // deadline. If the file ever appears, the tree was not terminated.
  await writeFile(
    grandchild,
    `import { writeFileSync } from 'node:fs';\n`
      + `setTimeout(() => { writeFileSync(${JSON.stringify(marker)}, 'survived'); }, 6000);\n`,
    'utf8',
  );
  // Detachment is platform-specific on purpose, so the assertion actually
  // discriminates on each platform rather than passing for the wrong reason:
  //
  // - On Windows an orphan is torn down with its parent anyway (measured on this
  //   box), so a plain grandchild would "prove" tree termination even for a
  //   child-only kill. A detached grandchild survives a child-only kill and is
  //   only reached by `taskkill /T`, which is exactly the behaviour under test.
  // - On Unix the opposite holds: an orphan survives happily, but a detached
  //   grandchild would create its own process group and escape any group kill.
  //   Leaving it in the group is what the group-kill contract covers.
  const detach = process.platform === 'win32' ? ', detached: true' : '';
  await writeFile(
    parent,
    `import { spawn } from 'node:child_process';\n`
      + `const child = spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: 'ignore'${detach} });\n`
      + `child.unref();\n`
      + `process.stdin.resume();\n`
      + `setTimeout(() => {}, 60000);\n`,
    'utf8',
  );

  const started = Date.now();
  await assert.rejects(
    () => run({ command: process.execPath, args: [parent], timeoutMs: 800, killGraceMs: 300 }, { prompt: 'x' }),
    (thrown) => {
      assert.equal(thrown.code, 'TIMEOUT');
      return true;
    },
  );

  // Wait past the grandchild's write time before judging.
  await sleep(8_000 - (Date.now() - started));
  assert.equal(
    existsSync(marker),
    false,
    'a grandchild outlived the timeout: the process tree was not terminated',
  );
});

test('the child environment is an allowlist, never an implicit copy', async () => {
  const { file } = await fakeAdapter(`
    process.stdin.resume();
    process.stdin.on('end', () => {
      process.stdout.write(JSON.stringify({
        protocol: 1,
        ok: true,
        file: 'x.png',
        env: {
          allowed: process.env.PIXELPROOF_TEST_ALLOWED ?? null,
          secret: process.env.PIXELPROOF_TEST_SECRET ?? null,
          literal: process.env.PIXELPROOF_TEST_LITERAL ?? null,
          hasPath: typeof process.env.PATH === 'string' && process.env.PATH.length > 0,
        },
      }) + '\\n');
    });
  `);

  process.env.PIXELPROOF_TEST_ALLOWED = 'visible';
  process.env.PIXELPROOF_TEST_SECRET = 'must-not-leak';
  try {
    const result = await run(
      configFor(file, {
        envAllowlist: ['PIXELPROOF_TEST_ALLOWED'],
        env: { PIXELPROOF_TEST_LITERAL: 'explicit' },
      }),
      { prompt: 'x' },
    );
    assert.equal(result.response.env.allowed, 'visible');
    assert.equal(result.response.env.secret, null);
    assert.equal(result.response.env.literal, 'explicit');
    assert.equal(result.response.env.hasPath, true);
  } finally {
    delete process.env.PIXELPROOF_TEST_ALLOWED;
    delete process.env.PIXELPROOF_TEST_SECRET;
  }
});

test('arguments are argv entries, so shell metacharacters stay data', async () => {
  const { file } = await fakeAdapter(`
    process.stdin.resume();
    process.stdin.on('end', () => {
      process.stdout.write(JSON.stringify({
        protocol: 1,
        ok: true,
        file: 'x.png',
        argv: process.argv.slice(2),
      }) + '\\n');
    });
  `);

  const hostile = 'a & echo pwned > owned.txt | rm -rf . "quoted" %PATH%';
  const result = await run(configFor(file, { args: [file, hostile] }), { prompt: 'x' });
  assert.deepEqual(result.response.argv, [hostile]);
});

test('config and message shapes are validated before anything is spawned', async () => {
  await assert.rejects(() => exchange({ command: '' }, { protocol: 1 }), { code: 'INVALID_REQUEST' });
  await assert.rejects(
    () => exchange({ command: process.execPath, args: 'node script.mjs' }, { protocol: 1 }),
    { code: 'INVALID_REQUEST' },
  );
  await assert.rejects(
    () => exchange({ command: process.execPath, args: [], timeoutMs: 0 }, { protocol: 1 }),
    { code: 'INVALID_REQUEST' },
  );
  await assert.rejects(() => exchange({ command: process.execPath }, 'not an object'), {
    code: 'INVALID_REQUEST',
  });
  await assert.rejects(() => run({ command: process.execPath }, ['not', 'an', 'object']), {
    code: 'INVALID_REQUEST',
  });
});

test('extractReply prefers the protocol-bearing line and defaults are contract-sized', () => {
  assert.equal(extractReply('no json here'), null);
  assert.equal(extractReply(''), null);
  assert.deepEqual(extractReply('log\n{"protocol":1,"ok":true}\ntrailing log\n'), {
    protocol: 1,
    ok: true,
  });
  assert.deepEqual(extractReply('{"protocol":1,"ok":true}\n{"other":"object"}\n'), {
    protocol: 1,
    ok: true,
  });
  assert.deepEqual(extractReply('{"only":"object"}\n'), { only: 'object' });
  assert.equal(MAX_RESPONSE_BYTES, 1024 * 1024);

  const env = buildEnvironment({ envAllowlist: [], env: {} });
  assert.ok(Object.hasOwn(env, 'PATH'));
});
