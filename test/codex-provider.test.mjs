import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { generateWithCodex } from '../scripts/providers/codex.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const generatorPath = path.join(repositoryRoot, 'scripts', 'generate.mjs');
const onePixelPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

async function createFakeCodex(root, scriptSource) {
  const binDirectory = path.join(root, 'bin');
  const scriptPath = path.join(root, 'fake-codex.mjs');
  await mkdir(binDirectory, { recursive: true });
  await writeFile(scriptPath, scriptSource);

  if (process.platform === 'win32') {
    await writeFile(
      path.join(binDirectory, 'codex.cmd'),
      `@echo off\r\n"${process.execPath}" "%PIXELPROOF_FAKE_CODEX_SCRIPT%"\r\nexit /b %ERRORLEVEL%\r\n`,
    );
  } else {
    const executable = path.join(binDirectory, 'codex');
    await writeFile(
      executable,
      '#!/bin/sh\nexec "$PIXELPROOF_NODE" "$PIXELPROOF_FAKE_CODEX_SCRIPT"\n',
    );
    await chmod(executable, 0o755);
  }

  return { binDirectory, scriptPath };
}

async function withFakeCodex(scriptSource, callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pixelproof-codex-'));
  const codexHome = path.join(root, 'codex-home');
  const { binDirectory, scriptPath } = await createFakeCodex(root, scriptSource);
  const originalEnvironment = {
    CODEX_HOME: process.env.CODEX_HOME,
    PATH: process.env.PATH,
    PIXELPROOF_FAKE_CODEX_SCRIPT: process.env.PIXELPROOF_FAKE_CODEX_SCRIPT,
    PIXELPROOF_NODE: process.env.PIXELPROOF_NODE,
  };

  process.env.CODEX_HOME = codexHome;
  process.env.PATH = `${binDirectory}${path.delimiter}${originalEnvironment.PATH ?? ''}`;
  process.env.PIXELPROOF_FAKE_CODEX_SCRIPT = scriptPath;
  process.env.PIXELPROOF_NODE = process.execPath;

  try {
    await callback({ root, codexHome });
  } finally {
    for (const [name, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
}

function runGenerator(...arguments_) {
  return spawnSync(process.execPath, [generatorPath, ...arguments_], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: process.env,
  });
}

test('rejects a stale pre-existing target without modifying it', async () => {
  await withFakeCodex('', async ({ root }) => {
    const outputPath = path.join(root, 'output', 'result.png');
    const staleBytes = Buffer.from('pre-existing target');
    const staleTime = new Date('2020-01-01T00:00:00.000Z');
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, staleBytes);
    await utimes(outputPath, staleTime, staleTime);
    const before = await stat(outputPath);

    const result = runGenerator(
      '--provider', 'codex',
      '--prompt', 'test image',
      '--out', outputPath,
    );

    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /pre-existing file.*rejected as stale/is);
    assert.ok(result.stderr.includes(outputPath));
    assert.match(result.stderr, /2020-01-01T00:00:00\.000Z/);
    assert.match(result.stderr, /run start time "\d{4}-\d{2}-\d{2}T[^\"]+Z"/);
    assert.deepEqual(await readFile(outputPath), staleBytes);
    assert.equal((await stat(outputPath)).mtimeMs, before.mtimeMs);
  });
});

test('recovers a fresh session image when the target is stale', async () => {
  const freshBytes = Buffer.from('fresh session image');
  const fakeCodex = `
    import { mkdir, writeFile } from 'node:fs/promises';
    import path from 'node:path';
    const directory = path.join(process.env.CODEX_HOME, 'generated_images', 'fresh-session');
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'exec-fresh.png'), ${JSON.stringify(freshBytes.toString())});
  `;

  await withFakeCodex(fakeCodex, async ({ root }) => {
    const outputPath = path.join(root, 'output', 'result.png');
    const staleTime = new Date('2020-01-01T00:00:00.000Z');
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, 'pre-existing target');
    await utimes(outputPath, staleTime, staleTime);
    const notBefore = Date.now();

    const result = runGenerator(
      '--provider', 'codex',
      '--prompt', 'test image',
      '--out', outputPath,
    );

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(await readFile(outputPath), freshBytes);
    assert.ok((await stat(outputPath)).mtimeMs >= notBefore);
  });
});

test('accepts a target written directly during the Codex run', async () => {
  const freshBytes = Buffer.from('fresh direct target');
  const fakeCodex = `
    import { writeFile } from 'node:fs/promises';
    import path from 'node:path';
    await writeFile(path.join(process.cwd(), 'result.png'), ${JSON.stringify(freshBytes.toString())});
  `;

  await withFakeCodex(fakeCodex, async ({ root }) => {
    const outputPath = path.join(root, 'output', 'result.png');
    const notBefore = Date.now();

    const result = runGenerator(
      '--provider', 'codex',
      '--prompt', 'test image',
      '--out', outputPath,
    );

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(await readFile(outputPath), freshBytes);
    assert.ok((await stat(outputPath)).mtimeMs >= notBefore);
  });
});

test('recovers the newest post-run PNG recursively and logs the recovery', async () => {
  const fakeCodex = `
    import { mkdir, writeFile } from 'node:fs/promises';
    import path from 'node:path';
    const directory = path.join(process.env.CODEX_HOME, 'generated_images', 'fresh-session');
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'exec-fresh.png'), 'fresh');
  `;

  await withFakeCodex(fakeCodex, async ({ root, codexHome }) => {
    const staleDirectory = path.join(codexHome, 'generated_images', 'stale-session');
    const stalePath = path.join(staleDirectory, 'exec-stale.png');
    const outputPath = path.join(root, 'output', 'result.png');
    await mkdir(staleDirectory, { recursive: true });
    await writeFile(stalePath, 'stale');
    const oldTime = new Date(Date.now() - 60_000);
    await utimes(stalePath, oldTime, oldTime);

    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...values) => warnings.push(values.join(' '));
    try {
      await generateWithCodex({ prompt: 'test', outPath: outputPath, width: 1, height: 1 });
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(await readFile(outputPath, 'utf8'), 'fresh');
    assert.equal(await readFile(stalePath, 'utf8'), 'stale');
    assert.match(warnings.join('\n'), /Recovered image from the Codex session directory/);
  });
});

test('rejects stale fallback images when Codex produces nothing', async () => {
  await withFakeCodex('', async ({ root, codexHome }) => {
    const staleDirectory = path.join(codexHome, 'generated_images', 'stale-session');
    const stalePath = path.join(staleDirectory, 'exec-stale.png');
    const outputPath = path.join(root, 'output', 'result.png');
    await mkdir(staleDirectory, { recursive: true });
    await writeFile(stalePath, 'stale');
    const oldTime = new Date(Date.now() - 60_000);
    await utimes(stalePath, oldTime, oldTime);

    await assert.rejects(
      generateWithCodex({ prompt: 'test', outPath: outputPath, width: 1, height: 1 }),
      /no post-run image was found under .*generated_images.* either/,
    );
    assert.equal((await stat(stalePath)).isFile(), true);
  });
});

test('reports the normal no-image error when the generated-images directory is absent', async () => {
  await withFakeCodex('', async ({ root, codexHome }) => {
    const outputPath = path.join(root, 'output', 'result.png');

    await assert.rejects(
      generateWithCodex({ prompt: 'test', outPath: outputPath, width: 1, height: 1 }),
      new RegExp(`no post-run image was found under .*${path.basename(codexHome)}.* either`),
    );
  });
});

test('verifies size-only dimensions and exits non-zero when the generated PNG mismatches', async () => {
  const fakeCodex = `
    import { mkdir, writeFile } from 'node:fs/promises';
    import path from 'node:path';
    const directory = path.join(process.env.CODEX_HOME, 'generated_images', 'size-mismatch');
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'exec-mismatch.png'), Buffer.from('${onePixelPng}', 'base64'));
  `;

  await withFakeCodex(fakeCodex, async ({ root }) => {
    const outputPath = path.join(root, 'output', 'result.png');
    const result = runGenerator(
      '--provider', 'codex',
      '--prompt', 'test image',
      '--out', outputPath,
      '--size', '1024x1024',
    );

    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /Mechanical verification: FAIL/);
    assert.match(result.stdout, /Summary: 0 passed, 2 failed, 0 skipped/);
  });
});

test('rejects an impossible size before invoking Codex', async () => {
  const fakeCodex = `
    import { mkdir, writeFile } from 'node:fs/promises';
    import path from 'node:path';
    await mkdir(process.env.CODEX_HOME, { recursive: true });
    await writeFile(path.join(process.env.CODEX_HOME, 'generation-attempted'), 'yes');
  `;

  await withFakeCodex(fakeCodex, async ({ root, codexHome }) => {
    const outputPath = path.join(root, 'output', 'result.png');
    const result = runGenerator(
      '--provider', 'codex',
      '--prompt', 'test image',
      '--out', outputPath,
      '--size', '100x100',
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /minimum total pixel count/i);
    await assert.rejects(stat(path.join(codexHome, 'generation-attempted')), { code: 'ENOENT' });
  });
});

test('warns on size and spec disagreement, then verifies against the spec dimensions', async () => {
  const fakeCodex = `
    import { mkdir, writeFile } from 'node:fs/promises';
    import path from 'node:path';
    const directory = path.join(process.env.CODEX_HOME, 'generated_images', 'spec-authority');
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'exec-spec.png'), Buffer.from('${onePixelPng}', 'base64'));
  `;

  await withFakeCodex(fakeCodex, async ({ root }) => {
    const outputPath = path.join(root, 'output', 'result.png');
    const specPath = path.join(root, 'spec.json');
    await writeFile(specPath, JSON.stringify({ mechanical: { width: 1024, height: 1024 } }));
    const result = runGenerator(
      '--provider', 'codex',
      '--prompt', 'test image',
      '--out', outputPath,
      '--size', '1536x1024',
      '--spec', specPath,
    );

    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /--size requested 1536x1024.*spec dimensions are 1024x1024.*spec is authoritative/i,
    );
    assert.match(result.stdout, /Mechanical verification: FAIL/);
    assert.match(result.stdout, /Summary: 0 passed, 2 failed, 0 skipped/);
  });
});
