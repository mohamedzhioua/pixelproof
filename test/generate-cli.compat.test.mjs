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

/**
 * The frozen banner, held byte for byte.
 *
 * The three `--judge*` / `--run-dir` lines and the `Host judgement:` section were
 * added on 2026-08-13 under the amendment to ADR 0003, which permits purely
 * additive lines documenting a new flag while every existing line stays
 * byte-identical. The `--retakes` line and the `Retakes:` section were added the
 * same way on 2026-08-14 for ADR 0020. Updating this constant is the deliberate
 * act that amendment requires: it is the evidence, so it is edited with intent,
 * and it is never deleted or loosened into a substring match to make a diff go
 * away. Every line that was here before is still here, unchanged and in the same
 * order — and that is not left to this comment to promise.
 * `test/judge-cli.test.mjs` holds every pre-amendment line as an ordered
 * subsequence, so a banner pasted in after rewording a historical line on the
 * way still fails there.
 */
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
  --judge host             Ask the calling agent to judge the spec's semantic assertions
  --judge-deadline <dur>   How long the checklist stays answerable (default 24h)
  --retakes <n>            Maximum total attempts in a judged run; needs --judge
  --run-dir <path>         Run root; also PIXELPROOF_RUN_ROOT (default .pixelproof/runs)
  -h, --help               Show this help

Size verification:
  --size without --spec creates a width/height mechanical spec and affects the exit code.
  Codex sizes must have edges divisible by 16, each edge <= 3840, an aspect ratio <= 3:1,
  and a total pixel count from 655360 through 8294400.

Provider selection:
  --provider, then PIXELPROOF_PROVIDER, then .svg output, then Codex on PATH.

Host judgement:
  --judge host writes a checklist and exits 2: an outstanding judgement, never a pass.
  The artifact is written into the run directory and appears at --out only once the run
  is accepted, so a rejected or abandoned run leaves no file there. Answer it with
  \`pixelproof judge submit\`. Needs a .png target and a spec with at least one "semantic"
  entry. --judge-deadline takes a duration such as 6h or 90m; a unit is required, because
  a bare number could be seconds or milliseconds.

Retakes:
  --retakes <n> bounds the total attempts inside one judged run and defaults to
  spec.retakes, then to 1. It needs --judge: without one, generate makes exactly one
  provider call, so honouring a bound would only change what the call costs. A rejected
  attempt leaves the run open; continue it with \`pixelproof retake --run <id>\`. Nothing
  is promoted on exhaustion.
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

// ADR 0008: neither run can prove which session image is its own, so both are
// rejected. The old behaviour — newest fresh PNG wins — let one run adopt the
// other's image and report success, which is a silent wrong result.
//
// The two file barriers below make this deterministic rather than racy. Barrier
// one holds both fake sessions until both runs exist, so neither image can be
// written before the other run has sampled its run-start reference (an image
// written earlier would look stale to the later run, leaving it a single
// unambiguous candidate). Barrier two holds both sessions open until both images
// are on disk, so each run's recovery scan — which happens after its own child
// exits — is guaranteed to see two candidates. Nothing here depends on a sleep
// or on which run wins a race.
test("two concurrent runs sharing CODEX_HOME are rejected as ambiguous instead of recovering each other's images", async () => {
  const root = await temporaryDirectory('pixelproof-concurrent-home-');
  const fakeSource = `
    import { access, mkdir, writeFile } from 'node:fs/promises';
    import path from 'node:path';
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const root = process.env.PIXELPROOF_FAKE_ROOT;
    const role = process.env.PIXELPROOF_FAKE_ROLE;
    const other = role === 'first' ? 'second' : 'first';
    const marker = (name) => path.join(root, name);
    async function waitFor(file) {
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        try { await access(file); return; } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        await sleep(25);
      }
      throw new Error('coordination timeout waiting for ' + file);
    }

    await writeFile(marker(role + '-started'), 'ready');
    await waitFor(marker(other + '-started'));

    const directory = path.join(process.env.CODEX_HOME, 'generated_images', role + '-session');
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'exec-' + role + '.png'), role + ' run image');

    await writeFile(marker(role + '-image'), 'ready');
    await waitFor(marker(other + '-image'));
  `;

  try {
    const fake = await createFakeCodex(root, fakeSource);
    const firstTarget = path.join(root, 'first', 'result.png');
    const secondTarget = path.join(root, 'second', 'result.png');
    const first = runScriptAsync(generatorPath, [
      '--provider', 'codex', '--prompt', 'first run', '--out', firstTarget,
    ], { env: fake.env({ PIXELPROOF_FAKE_ROOT: root, PIXELPROOF_FAKE_ROLE: 'first' }) });
    await waitForFile(path.join(root, 'first-started'));
    const second = runScriptAsync(generatorPath, [
      '--provider', 'codex', '--prompt', 'second run', '--out', secondTarget,
    ], { env: fake.env({ PIXELPROOF_FAKE_ROOT: root, PIXELPROOF_FAKE_ROLE: 'second' }) });
    const results = await Promise.all([first, second]);

    for (const [role, raw] of [['first', results[0]], ['second', results[1]]]) {
      const normalised = normaliseResult(raw, { TMP: root });
      assert.equal(normalised.status, 1, `${role}: ${normalised.stdout}${normalised.stderr}`);
      assert.equal(normalised.stdout, '');
      assert.match(
        normalised.stderr,
        /Generation error: Ambiguous image recovery: 2 images under <TMP>\/codex-home\/generated_images were created after this run started/,
      );
      // Both candidates are named, so the user can see the other run.
      assert.match(normalised.stderr, /first-session\/exec-first\.png \(modified "<TIMESTAMP>"\)/);
      assert.match(normalised.stderr, /second-session\/exec-second\.png \(modified "<TIMESTAMP>"\)/);
      assert.match(normalised.stderr, /No file was moved, adopted, or deleted/);
    }

    // Neither run adopted anything: no target was written, and both session
    // images are still where Codex left them.
    await assert.rejects(stat(firstTarget), { code: 'ENOENT' });
    await assert.rejects(stat(secondTarget), { code: 'ENOENT' });
    const sessions = path.join(root, 'codex-home', 'generated_images');
    assert.equal(
      await readFile(path.join(sessions, 'first-session', 'exec-first.png'), 'utf8'),
      'first run image',
    );
    assert.equal(
      await readFile(path.join(sessions, 'second-session', 'exec-second.png'), 'utf8'),
      'second run image',
    );
  } finally {
    await removeTemporaryDirectory(root);
  }
});
