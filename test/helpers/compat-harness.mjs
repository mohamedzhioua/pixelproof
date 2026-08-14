import { spawn, spawnSync } from 'node:child_process';
import {
  access,
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

export const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
export const generatorPath = path.join(repositoryRoot, 'scripts', 'generate.mjs');
export const verifierPath = path.join(repositoryRoot, 'scripts', 'verify.mjs');

/**
 * Always returns the *resolved* path.
 *
 * On macOS `os.tmpdir()` is `/var/folders/...`, which is a symlink to
 * `/private/var/folders/...`. Anything that resolves the real path — Node's ESM
 * loader, or the product writing a file and reporting where it landed — emits
 * the `/private` form, while a token built from the unresolved path only matches
 * the tail. That leaves `/private<TMP>` stranded in normalised output and fails
 * assertions on macOS alone, which is invisible from Linux or Windows.
 */
export async function temporaryDirectory(prefix) {
  return realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
}

export async function removeTemporaryDirectory(directory) {
  await rm(directory, { recursive: true, force: true });
}

/**
 * Copy one module into `root`, at its repo-relative location, together with
 * every layer it imports — so it runs where `sharp` (or any other optional
 * dependency) cannot be resolved. That is how the degraded paths are exercised
 * without uninstalling anything.
 *
 * The layers matter. Copying a subset makes the run fail with
 * ERR_MODULE_NOT_FOUND, which from outside is indistinguishable from the
 * missing-dependency condition this helper exists to create — a test that
 * "passes" for the wrong reason, or fails for one. Layout is preserved so the
 * module's own relative specifiers (`../core/...`) resolve unchanged, which is
 * what lets an isolated module be a thin one rather than a self-contained copy.
 *
 * Isolation itself comes from the destination having no `node_modules`.
 *
 * @param {string} root destination directory (a fresh temporary directory)
 * @param {string} modulePath repo-relative POSIX path of the module to isolate
 * @param {string[]} layers repo-relative top-level directories it imports
 * @returns {Promise<string>} absolute path of the isolated module
 */
export async function isolateModule(root, modulePath, layers) {
  for (const layer of layers) {
    await cp(path.join(repositoryRoot, layer), path.join(root, layer), { recursive: true });
  }
  const segments = modulePath.split('/');
  const isolated = path.join(root, ...segments);
  await mkdir(path.dirname(isolated), { recursive: true });
  await copyFile(path.join(repositoryRoot, ...segments), isolated);
  return isolated;
}

/**
 * The verifier flavour of `isolateModule`: it imports `core/` and `surfaces/`.
 *
 * In-process callers should inject `loadDecoder` instead; this exists for
 * CLI-level tests, where there is deliberately no flag to defeat decoder
 * discovery.
 */
export async function isolateVerifier(root) {
  return isolateModule(root, 'scripts/verify.mjs', ['core', 'surfaces']);
}

export function environment(overrides = {}) {
  const result = { ...process.env };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined || value === null) delete result[name];
    else result[name] = String(value);
  }
  return result;
}

export function normaliseText(value, replacements = {}) {
  let normalised = String(value ?? '')
    .replaceAll('\r\n', '\n')
    .replaceAll('\\', '/')
    .replace(/\b\d+(?:\.\d+)?\s*ms\b/gi, '<DURATION>')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '<TIMESTAMP>');

  const entries = Object.entries(replacements)
    .filter(([, original]) => original)
    .sort((left, right) => String(right[1]).length - String(left[1]).length);
  for (const [token, original] of entries) {
    const portable = String(original).replaceAll('\\', '/');
    normalised = normalised.split(portable).join(`<${token}>`);
  }
  return normalised;
}

export function normaliseResult(result, replacements = {}) {
  return {
    status: result.status,
    signal: result.signal,
    stdout: normaliseText(result.stdout, replacements),
    stderr: normaliseText(result.stderr, replacements),
    error: result.error,
  };
}

export function runScript(scriptPath, arguments_ = [], options = {}) {
  return spawnSync(process.execPath, [scriptPath, ...arguments_], {
    cwd: options.cwd ?? repositoryRoot,
    encoding: 'utf8',
    env: options.env ?? process.env,
    input: options.input,
    maxBuffer: 20 * 1024 * 1024,
  });
}

export function runScriptAsync(scriptPath, arguments_ = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...arguments_], {
      cwd: options.cwd ?? repositoryRoot,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

const DEFAULT_FAKE_CODEX = `
  import { mkdir, readFile, writeFile } from 'node:fs/promises';
  import path from 'node:path';
  const encoded = process.env.PIXELPROOF_CODEX_ARGS_B64;
  const args = encoded
    ? JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))
    : process.argv.slice(2);
  if (process.env.PIXELPROOF_FAKE_CAPTURE) {
    await mkdir(path.dirname(process.env.PIXELPROOF_FAKE_CAPTURE), { recursive: true });
    await writeFile(process.env.PIXELPROOF_FAKE_CAPTURE, JSON.stringify(args));
  }
  const delay = Number(process.env.PIXELPROOF_FAKE_DELAY_MS ?? 0);
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  if (process.env.PIXELPROOF_FAKE_IMAGE && process.env.PIXELPROOF_FAKE_OUT) {
    const bytes = await readFile(process.env.PIXELPROOF_FAKE_IMAGE);
    await writeFile(path.join(process.cwd(), process.env.PIXELPROOF_FAKE_OUT), bytes);
  }
`;

/**
 * The Windows shim the *judge's* executable resolution actually reaches.
 *
 * `judges/codex.mjs` spawns with `shell: false`, so a `.cmd` shim is not
 * directly spawnable and is treated as a *marker*: the resolver then looks for
 * the vendored `.exe` and, failing that, for the package's own Node launcher at
 * `node_modules/@openai/codex/bin/codex.js`, which it runs through
 * `process.execPath`. This is that launcher.
 *
 * It forwards `process.argv` untouched — which is the point. The provider's
 * `.cmd` shim passes arguments through an environment variable, so a test using
 * only that shim would never prove the judge's argv reached anything. Here the
 * fake script sees exactly the argv `buildJudgeArgs` produced.
 *
 * It also **bakes in** the absolute path of the fake script rather than reading
 * it from the environment. It has to: the judge transport forwards only its own
 * allowlist (ADR 0007), so a launcher that needed `PIXELPROOF_FAKE_CODEX_SCRIPT`
 * would find it stripped and fail in a way indistinguishable from a broken
 * judge. Anything else a fake judge needs to know has to arrive the same way.
 */
function windowsJudgeLauncher(scriptPath) {
  return `
  import { pathToFileURL } from 'node:url';
  await import(pathToFileURL(${JSON.stringify(scriptPath)}).href);
`;
}

export async function createFakeCodex(root, scriptSource = DEFAULT_FAKE_CODEX) {
  const binDirectory = path.join(root, 'bin');
  const scriptPath = path.join(root, 'fake-codex.mjs');
  const codexHome = path.join(root, 'codex-home');
  await mkdir(binDirectory, { recursive: true });
  await writeFile(scriptPath, scriptSource, 'utf8');

  if (process.platform === 'win32') {
    await writeFile(
      path.join(binDirectory, 'codex.cmd'),
      '@echo off\r\n"%PIXELPROOF_NODE%" "%PIXELPROOF_FAKE_CODEX_SCRIPT%"\r\nexit /b %ERRORLEVEL%\r\n',
      'utf8',
    );

    // Placed beside the `.cmd` in the same PATH directory, exactly where an
    // npm-global Codex install puts it, so the judge's resolver finds it by its
    // real rule rather than by a rule invented for the test.
    const launcher = path.join(binDirectory, 'node_modules', '@openai', 'codex', 'bin');
    await mkdir(launcher, { recursive: true });
    await writeFile(path.join(launcher, 'codex.js'), windowsJudgeLauncher(scriptPath), 'utf8');
  } else {
    // The same shim serves both roles on POSIX — the judge's resolver returns
    // `<dir>/codex` directly — so it bakes its paths in for the reason the
    // Windows launcher does: a judging child receives only the allowlisted
    // environment, and `$PIXELPROOF_NODE` would be empty inside it.
    const executable = path.join(binDirectory, 'codex');
    await writeFile(
      executable,
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)} "$@"\n`,
      'utf8',
    );
    await chmod(executable, 0o755);
  }

  return {
    binDirectory,
    codexHome,
    scriptPath,
    env(overrides = {}) {
      return environment({
        CODEX_HOME: codexHome,
        PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ''}`,
        PIXELPROOF_FAKE_CODEX_SCRIPT: scriptPath,
        PIXELPROOF_NODE: process.execPath,
        PIXELPROOF_PROVIDER: undefined,
        PIXELPROOF_CODEX_MODEL: undefined,
        PIXELPROOF_CODEX_EFFORT: undefined,
        PIXELPROOF_TIMEOUT_MS: undefined,
        ...overrides,
      });
    },
  };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) === 1 ? (crc >>> 1) ^ 0xEDB88320 : crc >>> 1;
  }
  return crc >>> 0;
});

function crc32(buffer) {
  let crc = 0xFFFFFFFF;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

export function createPng(width, height, options = {}) {
  const color = options.color ?? [255, 255, 255, 255];
  const pixel = options.pixel ?? (() => color);
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const rgba = pixel(x, y);
      const offset = row + 1 + x * 4;
      raw[offset] = rgba[0];
      raw[offset + 1] = rgba[1];
      raw[offset + 2] = rgba[2];
      raw[offset + 3] = rgba[3];
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export async function writePng(filePath, width, height, options = {}) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, createPng(width, height, options));
}

export async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

export async function hasSharp() {
  try {
    await import('sharp');
    return true;
  } catch {
    return false;
  }
}

export async function waitForFile(filePath, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(filePath);
      return;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}
