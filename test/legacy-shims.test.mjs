import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  createFakeCodex,
  environment,
  generatorPath,
  normaliseResult,
  removeTemporaryDirectory,
  repositoryRoot,
  runScript,
  temporaryDirectory,
  verifierPath,
  writePng,
} from './helpers/compat-harness.mjs';

/**
 * Differential equivalence between the legacy scripts and the `pixelproof`
 * executable.
 *
 * The claim under test is narrow and total: `node scripts/<command>.mjs X` and
 * `pixelproof <command> X` are the *same run*, not two runs that happen to
 * agree. So every case here executes both surfaces for real and compares raw
 * stdout, stderr and exit status after the harness's normalisation — reading
 * the two files and concluding they look alike is exactly the unverified claim
 * this project exists to prevent.
 *
 * Each case is built twice, in two separate temporary roots, and each root is
 * normalised to `<TMP>` in its own output. Sharing one root would let a run
 * observe the previous run's leftovers, so a real divergence — say, one surface
 * skipping generation because the file already existed — would be normalised
 * away into a false pass.
 */

const binaryPath = path.join(repositoryRoot, 'bin', 'pixelproof.mjs');

const VALID_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="#fff"/></svg>';

/** Neutralise the ambient environment so a developer's shell cannot skew a case. */
function neutralEnvironment(overrides = {}) {
  return environment({
    PIXELPROOF_PROVIDER: undefined,
    PIXELPROOF_CODEX_MODEL: undefined,
    PIXELPROOF_CODEX_EFFORT: undefined,
    PIXELPROOF_TIMEOUT_MS: undefined,
    ...overrides,
  });
}

async function writeReadmeVerifyFixtures(root) {
  const outputDirectory = path.join(root, 'output');
  const specDirectory = path.join(root, 'specs');
  await Promise.all([mkdir(outputDirectory), mkdir(specDirectory)]);
  await Promise.all([
    writePng(path.join(outputDirectory, 'lamp.png'), 1254, 1254),
    copyFile(
      path.join(repositoryRoot, 'specs', 'product-hero.example.json'),
      path.join(specDirectory, 'product-hero.example.json'),
    ),
  ]);
}

const README_VERIFY_ARGUMENTS = [
  '--file', 'output/lamp.png', '--spec', 'specs/product-hero.example.json',
];

/**
 * Every case: the subcommand, and a builder that materialises its fixtures in a
 * fresh root and returns the invocation. `args` are the legacy arguments; the
 * executable is given the same list behind the command name, because the
 * subcommand is a synonym and not a dialect.
 */
const CASES = [
  // --- verify: banners, parser errors, required options ---
  {
    command: 'verify',
    name: 'verify --help',
    build: (root) => ({ args: ['--help'], cwd: root }),
  },
  {
    command: 'verify',
    name: 'verify -h',
    build: (root) => ({ args: ['-h'], cwd: root }),
  },
  {
    command: 'verify',
    name: 'verify with no arguments',
    build: (root) => ({ args: [], cwd: root }),
  },
  {
    command: 'verify',
    name: 'verify --file without a value',
    build: (root) => ({ args: ['--file'], cwd: root }),
  },
  {
    command: 'verify',
    name: 'verify with an unknown argument',
    build: (root) => ({ args: ['--unknown'], cwd: root }),
  },

  // --- verify: the three documented README invocations ---
  {
    command: 'verify',
    name: 'README verify, human output',
    async build(root) {
      await writeReadmeVerifyFixtures(root);
      return { args: README_VERIFY_ARGUMENTS, cwd: root };
    },
  },
  {
    command: 'verify',
    name: 'README verify, --json',
    async build(root) {
      await writeReadmeVerifyFixtures(root);
      return { args: [...README_VERIFY_ARGUMENTS, '--json'], cwd: root };
    },
  },
  {
    command: 'verify',
    name: 'README verify, --strict',
    async build(root) {
      await writeReadmeVerifyFixtures(root);
      return { args: [...README_VERIFY_ARGUMENTS, '--strict'], cwd: root };
    },
  },

  // --- verify: documented result and error semantics ---
  {
    command: 'verify',
    name: 'verify an empty mechanical block',
    async build(root) {
      await writePng(path.join(root, 'probe.png'), 1, 1);
      await writeFile(path.join(root, 'empty.json'), JSON.stringify({ mechanical: {} }));
      return { args: ['--file', 'probe.png', '--spec', 'empty.json'], cwd: root };
    },
  },
  {
    command: 'verify',
    name: 'verify a failing check as JSON',
    async build(root) {
      await writePng(path.join(root, 'probe.png'), 1, 1);
      await writeFile(path.join(root, 'failing.json'), JSON.stringify({ mechanical: { width: 2 } }));
      return { args: ['--file', 'probe.png', '--spec', 'failing.json', '--json'], cwd: root };
    },
  },
  {
    command: 'verify',
    name: 'verify a spec that is not valid JSON',
    async build(root) {
      await writePng(path.join(root, 'probe.png'), 1, 1);
      await writeFile(path.join(root, 'invalid.json'), '{');
      return { args: ['--file', 'probe.png', '--spec', 'invalid.json'], cwd: root };
    },
  },
  {
    command: 'verify',
    name: 'verify a spec with the wrong shape',
    async build(root) {
      await writePng(path.join(root, 'probe.png'), 1, 1);
      await writeFile(path.join(root, 'shape.json'), JSON.stringify({ mechanical: [] }));
      return { args: ['--file', 'probe.png', '--spec', 'shape.json'], cwd: root };
    },
  },
  {
    command: 'verify',
    name: 'verify an invalid check under --strict --json',
    async build(root) {
      await writePng(path.join(root, 'probe.png'), 1, 1);
      await writeFile(path.join(root, 'check.json'), JSON.stringify({ mechanical: { width: 0 } }));
      return {
        args: ['--file', 'probe.png', '--spec', 'check.json', '--strict', '--json'],
        cwd: root,
      };
    },
  },
  {
    command: 'verify',
    name: 'verify a file that does not exist',
    build: (root) => ({ args: ['--file', 'absent.png'], cwd: root }),
  },

  // --- generate: banners, parser errors, required options ---
  {
    command: 'generate',
    name: 'generate --help',
    build: (root) => ({ args: ['--help'], cwd: root }),
  },
  {
    command: 'generate',
    name: 'generate with no arguments',
    build: (root) => ({ args: [], cwd: root }),
  },
  {
    command: 'generate',
    name: 'generate --out without a value',
    build: (root) => ({ args: ['--out'], cwd: root }),
  },
  {
    command: 'generate',
    name: 'generate with an unknown argument',
    build: (root) => ({ args: ['--unknown'], cwd: root }),
  },
  {
    command: 'generate',
    name: 'generate without the Codex prompt',
    build: (root) => ({
      args: ['--provider', 'codex', '--out', 'unused.png'],
      cwd: root,
      env: neutralEnvironment(),
    }),
  },
  {
    command: 'generate',
    name: 'generate with a malformed --size',
    build: (root) => ({
      args: ['--provider', 'codex', '--prompt', 'bad size', '--out', 'unused.png', '--size', '1024'],
      cwd: root,
      env: neutralEnvironment(),
    }),
  },
  {
    command: 'generate',
    name: 'generate with a size the Codex preflight rejects',
    build: (root) => ({
      args: [
        '--provider', 'codex', '--prompt', 'preflight', '--out', 'unused.png', '--size', '512x512',
      ],
      cwd: root,
      env: neutralEnvironment(),
    }),
  },
  {
    command: 'generate',
    name: 'generate with no provider available',
    async build(root) {
      const emptyBin = path.join(root, 'empty-bin');
      await mkdir(emptyBin, { recursive: true });
      return {
        args: ['--prompt', 'no provider', '--out', 'missing.png'],
        cwd: root,
        env: neutralEnvironment({ PATH: emptyBin }),
      };
    },
  },

  // --- generate: the documented README invocations ---
  {
    command: 'generate',
    name: 'README SVG generation, vector output',
    async build(root) {
      await mkdir(path.join(root, 'artwork'), { recursive: true });
      await mkdir(path.join(root, 'output'), { recursive: true });
      await writeFile(path.join(root, 'artwork', 'icon.svg'), VALID_SVG);
      return {
        args: ['--provider', 'svg', '--svg-file', 'artwork/icon.svg', '--out', 'output/icon.svg'],
        cwd: root,
        env: neutralEnvironment(),
      };
    },
  },
  {
    command: 'generate',
    name: 'README SVG generation, optional rasterisation',
    async build(root) {
      await mkdir(path.join(root, 'artwork'), { recursive: true });
      await mkdir(path.join(root, 'output'), { recursive: true });
      await writeFile(path.join(root, 'artwork', 'icon.svg'), VALID_SVG);
      return {
        args: [
          '--provider', 'svg', '--svg-file', 'artwork/icon.svg',
          '--out', 'output/icon.png', '--size', '512x512',
        ],
        cwd: root,
        env: neutralEnvironment(),
      };
    },
  },
  {
    command: 'generate',
    name: 'README raster generation through Codex',
    async build(root) {
      const fake = await createFakeCodex(root);
      const imagePath = path.join(root, 'fake-lamp.png');
      await mkdir(path.join(root, 'specs'), { recursive: true });
      await Promise.all([
        writePng(imagePath, 1254, 1254),
        copyFile(
          path.join(repositoryRoot, 'specs', 'product-hero.example.json'),
          path.join(root, 'specs', 'product-hero.example.json'),
        ),
      ]);
      return {
        args: [
          '--prompt', 'A ceramic desk lamp on seamless white',
          '--out', 'output/lamp.png',
          '--size', '1254x1254',
          '--spec', 'specs/product-hero.example.json',
        ],
        cwd: root,
        env: fake.env({
          PIXELPROOF_FAKE_CAPTURE: path.join(root, 'capture.json'),
          PIXELPROOF_FAKE_IMAGE: imagePath,
          PIXELPROOF_FAKE_OUT: 'lamp.png',
        }),
      };
    },
  },
];

const LEGACY_SCRIPTS = { generate: generatorPath, verify: verifierPath };

/**
 * Run one invocation and normalise its root away, so two roots compare equal.
 *
 * The harness's own replacement covers plain paths, but a Windows path inside a
 * `--json` document is JSON-escaped to `C:\\Users\\...`, which the harness's
 * backslash folding turns into `C://Users//...` — a form its single-slash token
 * never matches. Left unhandled, every JSON case would compare two absolute
 * temp paths and fail for a reason that has nothing to do with the two
 * surfaces, so the doubled form is scrubbed here as well. On POSIX the root has
 * no backslashes and this is a no-op.
 */
function execute(scriptPath, args, invocation, root) {
  const result = normaliseResult(
    runScript(scriptPath, args, { cwd: invocation.cwd, env: invocation.env }),
    { TMP: root },
  );
  const doubled = String(root).replaceAll('\\', '//');
  const scrub = (value) => (doubled === root ? value : value.split(doubled).join('<TMP>'));
  return { ...result, stdout: scrub(result.stdout), stderr: scrub(result.stderr) };
}

for (const testCase of CASES) {
  test(`legacy shim and pixelproof agree: ${testCase.name}`, async () => {
    const legacyRoot = await temporaryDirectory('pixelproof-shim-legacy-');
    const surfaceRoot = await temporaryDirectory('pixelproof-shim-surface-');
    try {
      const legacyInvocation = await testCase.build(legacyRoot);
      const surfaceInvocation = await testCase.build(surfaceRoot);

      const legacy = execute(
        LEGACY_SCRIPTS[testCase.command],
        legacyInvocation.args,
        legacyInvocation,
        legacyRoot,
      );
      const surface = execute(
        binaryPath,
        [testCase.command, ...surfaceInvocation.args],
        surfaceInvocation,
        surfaceRoot,
      );

      assert.equal(legacy.error, undefined, `legacy run failed to start: ${legacy.error}`);
      assert.equal(surface.error, undefined, `pixelproof run failed to start: ${surface.error}`);
      assert.equal(surface.stdout, legacy.stdout, 'stdout diverged');
      assert.equal(surface.stderr, legacy.stderr, 'stderr diverged');
      assert.equal(surface.status, legacy.status, 'exit status diverged');
      assert.equal(surface.signal, legacy.signal, 'termination signal diverged');
    } finally {
      await Promise.all([
        removeTemporaryDirectory(legacyRoot),
        removeTemporaryDirectory(surfaceRoot),
      ]);
    }
  });
}

test('covers both commands, including their success paths, not only their banners', () => {
  const byCommand = new Map();
  for (const testCase of CASES) {
    byCommand.set(testCase.command, (byCommand.get(testCase.command) ?? 0) + 1);
  }
  assert.deepEqual([...byCommand.keys()].sort(), ['generate', 'verify']);
  for (const [command, count] of byCommand) {
    assert.ok(count >= 5, `${command} needs more than a handful of compared invocations`);
  }
});

/**
 * Comments are stripped before the shim source is scanned: a doc comment that
 * *says* "does not spawn a second Node" would otherwise trip a search for
 * `spawn`, and a test that fails on its own prose teaches people to weaken it.
 */
function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('the shims call the handlers in process rather than spawning another node', async () => {
  for (const scriptPath of [generatorPath, verifierPath]) {
    const raw = await readFile(scriptPath, 'utf8');
    const source = withoutComments(raw);
    assert.doesNotMatch(
      source,
      /child_process|spawn\s*\(|execFile\s*\(|process\.execPath/,
      `${path.basename(scriptPath)} must not start a second Node process`,
    );
    assert.match(
      source,
      /surfaces\/cli\/commands\//,
      `${path.basename(scriptPath)} must delegate to the shared command handler`,
    );
    assert.doesNotMatch(
      source,
      /process\.exit\s*\(/,
      `${path.basename(scriptPath)} must set process.exitCode, not call process.exit`,
    );
  }
});

test('routes unknown commands to a non-zero exit that names the real ones', () => {
  const unknown = normaliseResult(runScript(binaryPath, ['inspect']));
  assert.equal(unknown.status, 1);
  assert.equal(unknown.stdout, '');
  assert.match(unknown.stderr, /^Error: Unknown command: inspect\./);
  assert.match(unknown.stderr, /Available commands: generate, verify/);

  const bare = normaliseResult(runScript(binaryPath, []));
  assert.equal(bare.status, 1);
  assert.equal(bare.stdout, '');
  assert.match(bare.stderr, /^Error: a command is required/);
});

test('answers --help and --version at the top level from the manifest', async () => {
  const help = normaliseResult(runScript(binaryPath, ['--help']));
  assert.equal(help.status, 0);
  assert.equal(help.stderr, '');
  assert.match(help.stdout, /^Usage:$/m);
  assert.match(help.stdout, /^ {2}generate {2}/m);
  assert.match(help.stdout, /^ {2}verify {4}/m);

  const manifest = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'));
  const version = normaliseResult(runScript(binaryPath, ['--version']));
  assert.equal(version.status, 0);
  assert.equal(version.stderr, '');
  assert.equal(version.stdout, `${manifest.version}\n`);
  // A hardcoded version would drift silently at the next release.
  assert.doesNotMatch(
    await readFile(path.join(repositoryRoot, 'surfaces', 'cli', 'main.mjs'), 'utf8'),
    new RegExp(manifest.version.replaceAll('.', '\\.')),
  );
});

test('declares the executable in package.json and ships it with a shebang', async () => {
  const manifest = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'));
  assert.equal(manifest.bin?.pixelproof, 'bin/pixelproof.mjs');
  const source = await readFile(path.join(repositoryRoot, manifest.bin.pixelproof), 'utf8');
  assert.match(source, /^#!\/usr\/bin\/env node\n/);
});
