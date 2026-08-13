import assert from 'node:assert/strict';
import {
  copyFile,
  mkdir,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  createFakeCodex,
  environment,
  generatorPath,
  hasSharp,
  normaliseResult,
  readJson,
  removeTemporaryDirectory,
  repositoryRoot,
  runScript,
  runScriptAsync,
  temporaryDirectory,
  waitForFile,
  writePng,
} from './helpers/compat-harness.mjs';

const GENERATOR_USAGE = `pixelproof image generator

Usage:
  node scripts/generate.mjs --prompt "<text>" --out <path> [options]

Options:
  --prompt <text>          Raster generation prompt (required for Codex)
  --out <path>             Target .png or .svg path (required)
  --provider codex|svg     Override provider selection
  --size <WxH>             Desired pixels; verified when --spec is absent
  --spec <file>            Fold a JSON spec into the prompt and verify it; spec dimensions win
  --svg-file <path>        SVG source for the svg provider; otherwise read stdin
  -h, --help               Show this help

Size verification:
  --size without --spec creates a width/height mechanical spec and affects the exit code.
  Codex sizes must have edges divisible by 16, each edge <= 3840, an aspect ratio <= 3:1,
  and a total pixel count from 655360 through 8294400.

Provider selection:
  --provider, then PIXELPROOF_PROVIDER, then .svg output, then Codex on PATH.
`;

const VALID_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="#fff"/></svg>';

test('freezes generate help, parser errors, required options, exit codes, and output channels', () => {
  const help = normaliseResult(runScript(generatorPath, ['--help']));
  assert.equal(help.status, 0);
  assert.equal(help.stdout, `${GENERATOR_USAGE}\n`);
  assert.equal(help.stderr, '');

  const missingOut = normaliseResult(runScript(generatorPath));
  assert.equal(missingOut.status, 1);
  assert.equal(missingOut.stdout, '');
  assert.equal(missingOut.stderr, `Error: --out is required\n\n${GENERATOR_USAGE}\n`);

  const missingValue = normaliseResult(runScript(generatorPath, ['--out']));
  assert.equal(missingValue.status, 1);
  assert.equal(missingValue.stdout, '');
  assert.equal(missingValue.stderr, `Error: --out requires a value\n\n${GENERATOR_USAGE}\n`);

  const unknown = normaliseResult(runScript(generatorPath, ['--unknown']));
  assert.equal(unknown.status, 1);
  assert.equal(unknown.stdout, '');
  assert.equal(unknown.stderr, `Error: Unknown argument: --unknown\n\n${GENERATOR_USAGE}\n`);

  const missingPrompt = normaliseResult(runScript(generatorPath, [
    '--provider', 'codex', '--out', 'unused.png',
  ]));
  assert.equal(missingPrompt.status, 1);
  assert.equal(missingPrompt.stdout, '');
  assert.equal(
    missingPrompt.stderr,
    'Generation error: --prompt is required for the Codex provider\n',
  );
});

test('represents the README raster generation example and freezes its folded Codex request', async () => {
  const root = await temporaryDirectory('pixelproof-generate-readme-');
  try {
    const fake = await createFakeCodex(root);
    const capturePath = path.join(root, 'capture.json');
    const imagePath = path.join(root, 'fake-lamp.png');
    const specDirectory = path.join(root, 'specs');
    await mkdir(specDirectory, { recursive: true });
    await Promise.all([
      writePng(imagePath, 1254, 1254),
      copyFile(
        path.join(repositoryRoot, 'specs', 'product-hero.example.json'),
        path.join(specDirectory, 'product-hero.example.json'),
      ),
    ]);

    const result = normaliseResult(runScript(generatorPath, [
      '--prompt', 'A ceramic desk lamp on seamless white',
      '--out', 'output/lamp.png',
      '--size', '1254x1254',
      '--spec', 'specs/product-hero.example.json',
    ], {
      cwd: root,
      env: fake.env({
        PIXELPROOF_FAKE_CAPTURE: capturePath,
        PIXELPROOF_FAKE_IMAGE: imagePath,
        PIXELPROOF_FAKE_OUT: 'lamp.png',
      }),
    }), { TMP: root });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^Provider: codex$/m);
    assert.match(result.stdout, /^Output: <TMP>\/output\/lamp\.png$/m);
    assert.match(result.stdout, /^Mechanical verification: PASS/m);
    if (await hasSharp()) {
      assert.match(result.stdout, /Summary: 5 passed, 0 failed, 0 skipped/);
      assert.equal(result.stderr, '');
    } else {
      assert.match(result.stdout, /Summary: 3 passed, 0 failed, 2 skipped/);
      assert.match(result.stderr, /Warning: sharp is unavailable/);
    }

    const codexArgs = await readJson(capturePath);
    assert.deepEqual(
      codexArgs.slice(0, 4),
      ['exec', '--sandbox', 'workspace-write', '--skip-git-repo-check'],
    );
    assert.equal(codexArgs.includes('-m'), false);
    assert.equal(codexArgs.includes('-c'), false);
    const prompt = codexArgs.at(-1);
    assert.match(prompt, /^A ceramic desk lamp on seamless white/m);
    assert.match(prompt, /Output dimensions: exactly 1254x1254 pixels/);
    assert.match(prompt, /Zero text, letters, numbers, watermarks, labels or signage/);
    assert.match(prompt, /Save it as exactly "lamp\.png"/);
  } finally {
    await removeTemporaryDirectory(root);
  }
});

test('freezes provider precedence and the unavailable-provider error', async () => {
  const root = await temporaryDirectory('pixelproof-provider-precedence-');
  try {
    const fake = await createFakeCodex(root);
    const svgPath = path.join(root, 'artwork.svg');
    const fakeImage = path.join(root, 'fake.png');
    const emptyBin = path.join(root, 'empty-bin');
    await Promise.all([
      writeFile(svgPath, VALID_SVG),
      writePng(fakeImage, 8, 8),
      mkdir(emptyBin),
    ]);

    const explicit = normaliseResult(runScript(generatorPath, [
      '--provider', 'svg', '--svg-file', svgPath, '--out', path.join(root, 'explicit.svg'),
    ], { env: fake.env({ PIXELPROOF_PROVIDER: 'codex' }) }), { TMP: root });
    assert.equal(explicit.status, 0, explicit.stderr);
    assert.match(explicit.stdout, /^Provider: svg$/m);

    const fromEnvironment = normaliseResult(runScript(generatorPath, [
      '--svg-file', svgPath, '--out', path.join(root, 'environment.png'),
    ], { env: fake.env({ PIXELPROOF_PROVIDER: 'svg' }) }), { TMP: root });
    assert.equal(fromEnvironment.status, 0, fromEnvironment.stderr);
    assert.match(fromEnvironment.stdout, /^Provider: svg$/m);

    const fromExtension = normaliseResult(runScript(generatorPath, [
      '--svg-file', svgPath, '--out', path.join(root, 'extension.svg'),
    ], { env: fake.env() }), { TMP: root });
    assert.equal(fromExtension.status, 0, fromExtension.stderr);
    assert.match(fromExtension.stdout, /^Provider: svg$/m);

    const fromPath = normaliseResult(runScript(generatorPath, [
      '--prompt', 'default provider', '--out', path.join(root, 'path.png'),
    ], {
      env: fake.env({
        PIXELPROOF_FAKE_IMAGE: fakeImage,
        PIXELPROOF_FAKE_OUT: 'path.png',
      }),
    }), { TMP: root });
    assert.equal(fromPath.status, 0, fromPath.stderr);
    assert.match(fromPath.stdout, /^Provider: codex$/m);

    const unavailable = normaliseResult(runScript(generatorPath, [
      '--prompt', 'no provider', '--out', path.join(root, 'missing.png'),
    ], {
      env: environment({
        PATH: emptyBin,
        PIXELPROOF_PROVIDER: undefined,
      }),
    }), { TMP: root });
    assert.equal(unavailable.status, 1);
    assert.equal(unavailable.stdout, '');
    assert.match(unavailable.stderr, /Generation error: No image provider is available/);
    assert.match(unavailable.stderr, /--provider svg/);
  } finally {
    await removeTemporaryDirectory(root);
  }
});

test('freezes default dimensions, size parsing, verification, and Codex size preflight', async () => {
  const root = await temporaryDirectory('pixelproof-generate-size-');
  try {
    const fake = await createFakeCodex(root);
    const capturePath = path.join(root, 'capture.json');
    const smallImage = path.join(root, 'small.png');
    const sizedImage = path.join(root, 'sized.png');
    await Promise.all([
      writePng(smallImage, 8, 8),
      writePng(sizedImage, 1024, 1024),
    ]);

    const defaults = normaliseResult(runScript(generatorPath, [
      '--prompt', 'default square', '--out', path.join(root, 'default.png'),
    ], {
      env: fake.env({
        PIXELPROOF_FAKE_CAPTURE: capturePath,
        PIXELPROOF_FAKE_IMAGE: smallImage,
        PIXELPROOF_FAKE_OUT: 'default.png',
      }),
    }), { TMP: root });
    assert.equal(defaults.status, 0, defaults.stderr);
    assert.doesNotMatch(defaults.stdout, /Mechanical verification/);
    assert.match((await readJson(capturePath)).at(-1), /image at 1024x1024 pixels/);

    const sized = normaliseResult(runScript(generatorPath, [
      '--prompt', 'sized square', '--out', path.join(root, 'sized-output.png'),
      '--size', '1024X1024',
    ], {
      env: fake.env({
        PIXELPROOF_FAKE_CAPTURE: capturePath,
        PIXELPROOF_FAKE_IMAGE: sizedImage,
        PIXELPROOF_FAKE_OUT: 'sized-output.png',
      }),
    }), { TMP: root });
    assert.equal(sized.status, 0, sized.stderr);
    assert.match(sized.stdout, /Mechanical verification: PASS/);
    assert.match(sized.stdout, /Summary: 2 passed, 0 failed, 0 skipped/);

    const malformed = normaliseResult(runScript(generatorPath, [
      '--provider', 'codex', '--prompt', 'bad size', '--out', 'unused.png', '--size', '1024',
    ]));
    assert.equal(malformed.status, 1);
    assert.equal(
      malformed.stderr,
      'Generation error: --size must use the form WxH, for example 1254x1254\n',
    );

    const rejectedSizes = [
      ['512x512', /minimum total pixel count/],
      ['1025x1024', /width 1025 is not a multiple of 16/],
      ['4096x1600', /width 4096 exceeds the maximum edge length 3840/],
      ['3072x512', /exceeds the maximum 3:1 ratio/],
    ];
    for (const [size, message] of rejectedSizes) {
      const rejected = normaliseResult(runScript(generatorPath, [
        '--provider', 'codex', '--prompt', 'preflight', '--out', 'unused.png', '--size', size,
      ]));
      assert.equal(rejected.status, 1, size);
      assert.match(rejected.stderr, message, size);
    }
  } finally {
    await removeTemporaryDirectory(root);
  }
});

test('freezes spec-authoritative dimensions and warning channel', async () => {
  const root = await temporaryDirectory('pixelproof-spec-authority-');
  try {
    const fake = await createFakeCodex(root);
    const capturePath = path.join(root, 'capture.json');
    const imagePath = path.join(root, 'spec-size.png');
    const specPath = path.join(root, 'spec.json');
    await Promise.all([
      writePng(imagePath, 32, 16),
      writeFile(specPath, JSON.stringify({ mechanical: { width: 32, height: 16 } })),
    ]);

    const result = normaliseResult(runScript(generatorPath, [
      '--provider', 'codex',
      '--prompt', 'spec wins',
      '--out', path.join(root, 'result.png'),
      '--size', '1024x1024',
      '--spec', specPath,
    ], {
      env: fake.env({
        PIXELPROOF_FAKE_CAPTURE: capturePath,
        PIXELPROOF_FAKE_IMAGE: imagePath,
        PIXELPROOF_FAKE_OUT: 'result.png',
      }),
    }), { TMP: root });

    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stderr,
      /Warning: --size requested 1024x1024, but the spec dimensions are 32x16; the spec is authoritative\./,
    );
    assert.match(result.stdout, /Summary: 2 passed, 0 failed, 0 skipped/);
    assert.match((await readJson(capturePath)).at(-1), /exactly 32x16 pixels/);
  } finally {
    await removeTemporaryDirectory(root);
  }
});

test('freezes Codex model, effort, and timeout environment behavior', async () => {
  const root = await temporaryDirectory('pixelproof-generate-env-');
  try {
    const fake = await createFakeCodex(root);
    const capturePath = path.join(root, 'capture.json');
    const imagePath = path.join(root, 'fake.png');
    await writePng(imagePath, 8, 8);

    const configured = normaliseResult(runScript(generatorPath, [
      '--prompt', 'configured', '--out', path.join(root, 'configured.png'),
    ], {
      env: fake.env({
        PIXELPROOF_CODEX_MODEL: 'model-under-test',
        PIXELPROOF_CODEX_EFFORT: 'high',
        PIXELPROOF_FAKE_CAPTURE: capturePath,
        PIXELPROOF_FAKE_IMAGE: imagePath,
        PIXELPROOF_FAKE_OUT: 'configured.png',
      }),
    }), { TMP: root });
    assert.equal(configured.status, 0, configured.stderr);
    const args = await readJson(capturePath);
    assert.deepEqual(args.slice(4, 8), [
      '-m', 'model-under-test', '-c', 'model_reasoning_effort=high',
    ]);

    const timedOut = normaliseResult(runScript(generatorPath, [
      '--prompt', 'slow', '--out', path.join(root, 'timeout.png'),
    ], {
      env: fake.env({
        PIXELPROOF_FAKE_DELAY_MS: '10000',
        PIXELPROOF_FAKE_IMAGE: imagePath,
        PIXELPROOF_FAKE_OUT: 'timeout.png',
        PIXELPROOF_TIMEOUT_MS: '25',
      }),
    }), { TMP: root });
    assert.equal(timedOut.status, 1);
    assert.equal(timedOut.stdout, '');
    assert.match(timedOut.stderr, /Generation error: Codex timed out/);
  } finally {
    await removeTemporaryDirectory(root);
  }
});

test('represents both README SVG generation examples with and without optional rasterization', async () => {
  const root = await temporaryDirectory('pixelproof-svg-readme-');
  try {
    const artworkDirectory = path.join(root, 'artwork');
    const outputDirectory = path.join(root, 'output');
    await Promise.all([mkdir(artworkDirectory), mkdir(outputDirectory)]);
    await writeFile(path.join(artworkDirectory, 'icon.svg'), VALID_SVG);

    const vector = normaliseResult(runScript(generatorPath, [
      '--provider', 'svg', '--svg-file', 'artwork/icon.svg', '--out', 'output/icon.svg',
    ], { cwd: root }), { TMP: root });
    assert.equal(vector.status, 0, vector.stderr);
    assert.match(vector.stdout, /^Provider: svg$/m);
    assert.equal(await readFile(path.join(outputDirectory, 'icon.svg'), 'utf8'), VALID_SVG);

    const raster = normaliseResult(runScript(generatorPath, [
      '--provider', 'svg', '--svg-file', 'artwork/icon.svg', '--out', 'output/icon.png',
      '--size', '512x512',
    ], { cwd: root }), { TMP: root });
    assert.equal(raster.status, 0, raster.stderr);
    assert.match(raster.stdout, /^Provider: svg$/m);
    if (await hasSharp()) {
      assert.match(raster.stdout, /^Output: <TMP>\/output\/icon\.png$/m);
      assert.match(raster.stdout, /Summary: 2 passed, 0 failed, 0 skipped/);
      assert.equal((await stat(path.join(outputDirectory, 'icon.png'))).isFile(), true);
    } else {
      assert.match(raster.stdout, /^Output: <TMP>\/output\/icon\.svg$/m);
      assert.match(raster.stderr, /sharp is unavailable/);
      assert.match(raster.stderr, /mechanical verification needs a PNG raster/);
      await assert.rejects(stat(path.join(outputDirectory, 'icon.png')), { code: 'ENOENT' });
    }
  } finally {
    await removeTemporaryDirectory(root);
  }
});

// ADR 0008 will close this cross-run correlation hole with run-owned artifact identity.
test('two concurrent runs sharing CODEX_HOME cannot recover each other\'s images', { todo: true }, async () => {
  const root = await temporaryDirectory('pixelproof-concurrent-home-');
  const fakeSource = `
    import { access, mkdir, writeFile } from 'node:fs/promises';
    import path from 'node:path';
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const root = process.env.PIXELPROOF_FAKE_ROOT;
    const started = path.join(root, 'victim-started');
    const foreignReady = path.join(root, 'foreign-ready');
    async function waitFor(file) {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        try { await access(file); return; } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        await sleep(25);
      }
      throw new Error('coordination timeout');
    }
    if (process.env.PIXELPROOF_FAKE_ROLE === 'victim') {
      await writeFile(started, 'ready');
      await waitFor(foreignReady);
    } else {
      await waitFor(started);
      const directory = path.join(process.env.CODEX_HOME, 'generated_images', 'foreign-run');
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, 'foreign.png'), 'foreign run image');
      await writeFile(foreignReady, 'ready');
      await sleep(5000);
    }
  `;

  try {
    const fake = await createFakeCodex(root, fakeSource);
    const victimTarget = path.join(root, 'victim', 'result.png');
    const foreignTarget = path.join(root, 'foreign', 'result.png');
    const victim = runScriptAsync(generatorPath, [
      '--provider', 'codex', '--prompt', 'victim run', '--out', victimTarget,
    ], { env: fake.env({ PIXELPROOF_FAKE_ROOT: root, PIXELPROOF_FAKE_ROLE: 'victim' }) });
    await waitForFile(path.join(root, 'victim-started'));
    const foreign = runScriptAsync(generatorPath, [
      '--provider', 'codex', '--prompt', 'foreign run', '--out', foreignTarget,
    ], { env: fake.env({ PIXELPROOF_FAKE_ROOT: root, PIXELPROOF_FAKE_ROLE: 'foreign' }) });
    const [victimResult] = await Promise.all([victim, foreign]);
    const normalised = normaliseResult(victimResult, { TMP: root });

    assert.equal(normalised.status, 1, normalised.stdout);
    await assert.rejects(stat(victimTarget), { code: 'ENOENT' });
  } finally {
    await removeTemporaryDirectory(root);
  }
});
