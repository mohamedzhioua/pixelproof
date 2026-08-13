import { spawn, spawnSync } from 'node:child_process';
import {
  access,
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
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

export async function temporaryDirectory(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function removeTemporaryDirectory(directory) {
  await rm(directory, { recursive: true, force: true });
}

/**
 * Copy the verifier into `root` so it runs where `sharp` cannot be resolved,
 * which is how the degraded CLI path is exercised without uninstalling anything.
 *
 * The whole module tree is copied, not just the entry file: the verifier imports
 * `../core/`, and a lone copy would fail with a missing-module error rather than
 * a missing-decoder one. Those fail identically from the outside, so a test that
 * copied only the entry point would still be green while proving nothing.
 *
 * Isolation comes from the destination having no `node_modules`. In-process
 * callers should inject `loadDecoder` instead; this exists for CLI-level tests,
 * where there is deliberately no flag to defeat decoder discovery.
 */
export async function isolateVerifier(root) {
  const isolatedVerifier = path.join(root, 'scripts', 'verify.mjs');
  await mkdir(path.dirname(isolatedVerifier), { recursive: true });
  await cp(path.join(repositoryRoot, 'core'), path.join(root, 'core'), { recursive: true });
  await copyFile(verifierPath, isolatedVerifier);
  return isolatedVerifier;
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
  } else {
    const executable = path.join(binDirectory, 'codex');
    await writeFile(
      executable,
      '#!/bin/sh\nexec "$PIXELPROOF_NODE" "$PIXELPROOF_FAKE_CODEX_SCRIPT" "$@"\n',
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
