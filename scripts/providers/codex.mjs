import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, rename, stat, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_TIMEOUT_MS = 300_000;
const OUTPUT_TAIL_LENGTH = 4_000;

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function timeoutFromEnvironment() {
  const configured = process.env.PIXELPROOF_TIMEOUT_MS;
  return configured === undefined
    ? DEFAULT_TIMEOUT_MS
    : positiveInteger(configured, 'PIXELPROOF_TIMEOUT_MS');
}

function tail(value) {
  return value.length <= OUTPUT_TAIL_LENGTH
    ? value
    : value.slice(value.length - OUTPUT_TAIL_LENGTH);
}

function composePrompt({ prompt, width, height, targetFilename }) {
  return `${prompt.trim()}

Pixelproof output contract:
- Create exactly one raster image at ${width}x${height} pixels.
- Save it as exactly "${targetFilename}" in the current working directory.
- Do not write any other files.
- Use the built-in image generation tool to create the image; do not substitute SVG, HTML, or code-generated artwork.
- Before finishing, confirm that "${targetFilename}" exists.`;
}

function buildCodexArgs(prompt) {
  const args = ['exec', '--sandbox', 'workspace-write', '--skip-git-repo-check'];
  const model = process.env.PIXELPROOF_CODEX_MODEL;
  const effort = process.env.PIXELPROOF_CODEX_EFFORT;

  if (model) {
    args.push('-m', model);
  }
  if (effort) {
    args.push('-c', `model_reasoning_effort=${effort}`);
  }
  args.push(prompt);
  return args;
}

function resolveWindowsCodexCommand() {
  const directories = (process.env.PATH ?? '')
    .split(path.delimiter)
    .filter(Boolean)
    .map((directory) => directory.replace(/^"|"$/g, ''));
  const filenames = ['codex.exe', 'codex.cmd', 'codex.bat', 'codex.ps1', 'codex'];

  for (const directory of directories) {
    for (const filename of filenames) {
      const candidate = path.join(directory, filename);
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error('Codex CLI is not installed or is not available on PATH');
}

function windowsPowerShellInvocation(codexCommand, codexArgs) {
  // User prompt text stays in an environment variable rather than being interpolated
  // into shell source. PowerShell splats the decoded array as literal arguments.
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$decoded = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:PIXELPROOF_CODEX_ARGS_B64))',
    '$codexArgs = @(ConvertFrom-Json -InputObject $decoded)',
    '& $env:PIXELPROOF_CODEX_COMMAND @codexArgs',
    'exit $LASTEXITCODE',
  ].join('; ');

  return {
    command: 'powershell.exe',
    args: [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    env: {
      ...process.env,
      PIXELPROOF_CODEX_COMMAND: codexCommand,
      PIXELPROOF_CODEX_ARGS_B64: Buffer.from(JSON.stringify(codexArgs), 'utf8').toString('base64'),
    },
    shell: false,
  };
}

function codexInvocation(codexArgs) {
  if (process.platform === 'win32') {
    const codexCommand = resolveWindowsCodexCommand();
    if (path.extname(codexCommand).toLowerCase() === '.exe') {
      return {
        command: codexCommand,
        args: codexArgs,
        env: process.env,
        shell: false,
      };
    }
    return windowsPowerShellInvocation(codexCommand, codexArgs);
  }
  return {
    command: 'codex',
    args: codexArgs,
    env: process.env,
    shell: false,
  };
}

function terminateChild(child) {
  if (!child.pid) {
    return;
  }
  if (process.platform === 'win32') {
    child.kill();
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.unref();
  } else {
    child.kill('SIGTERM');
  }
}

function runCodex({ args, cwd, timeoutMs, startedAt }) {
  const invocation = codexInvocation(args);

  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd,
      env: invocation.env,
      shell: invocation.shell,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > OUTPUT_TAIL_LENGTH * 2) stdout = tail(stdout);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > OUTPUT_TAIL_LENGTH * 2) stderr = tail(stderr);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      terminateChild(child);
      setTimeout(() => {
        if (settled) return;
        settled = true;
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        resolve({
          code: null,
          signal: 'timeout',
          stdout: tail(stdout),
          stderr: tail(stderr),
          timedOut: true,
          startedAt,
        });
      }, 5_000);
    }, timeoutMs);

    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        signal,
        stdout: tail(stdout),
        stderr: tail(stderr),
        timedOut,
        startedAt,
      });
    });
  });
}

async function generatedFileStatus(filePath, notBefore) {
  try {
    const fileStats = await stat(filePath);
    // Existence alone can predate this run; mtime at or after run start is the production proof.
    return {
      exists: true,
      fresh: fileStats.mtimeMs >= notBefore,
      mtimeMs: fileStats.mtimeMs,
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { exists: false, fresh: false, mtimeMs: null };
    }
    throw error;
  }
}

function generatedImagesDirectory() {
  const codexHome = process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(os.homedir(), '.codex');
  return path.join(codexHome, 'generated_images');
}

async function newestGeneratedPng(notBefore) {
  const generatedDirectory = generatedImagesDirectory();
  const directories = [generatedDirectory];
  const candidates = [];

  while (directories.length > 0) {
    const directory = directories.pop();
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }

    for (const entry of entries) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        directories.push(filePath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.png')) {
        const fileStatus = await generatedFileStatus(filePath, notBefore);
        if (fileStatus.fresh) {
          candidates.push({ filePath, modified: fileStatus.mtimeMs });
        }
      }
    }
  }

  candidates.sort((left, right) => right.modified - left.modified);
  return candidates[0]?.filePath ?? null;
}

async function moveFile(source, destination) {
  try {
    await rename(source, destination);
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error;
    await copyFile(source, destination);
    await unlink(source);
  }
}

function failureMessage(result, targetPath, staleTarget) {
  const reason = result.timedOut
    ? 'Codex timed out'
    : `Codex exited with code ${result.code}${result.signal ? ` (${result.signal})` : ''}`;
  const targetFailure = staleTarget
    ? `a pre-existing file was found at ${targetPath} but rejected as stale because its mtime `
      + `"${new Date(staleTarget.mtimeMs).toISOString()}" predates the run start time `
      + `"${new Date(result.startedAt).toISOString()}"; the pre-existing file was left unchanged`
    : `no image was produced at ${targetPath}`;
  return `${reason}; ${targetFailure}, and no post-run image was found under ${generatedImagesDirectory()} either.

stdout tail:
${result.stdout || '(empty)'}

stderr tail:
${result.stderr || '(empty)'}`;
}

export async function generateWithCodex({ prompt, outPath, width, height }) {
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    throw new Error('The Codex provider requires a non-empty prompt');
  }
  const desiredWidth = positiveInteger(width, 'width');
  const desiredHeight = positiveInteger(height, 'height');
  const targetPath = path.resolve(outPath);
  const outputDirectory = path.dirname(targetPath);
  const targetFilename = path.basename(targetPath);
  if (path.extname(targetFilename).toLowerCase() !== '.png') {
    throw new Error('The Codex raster provider requires a .png output path');
  }

  await mkdir(outputDirectory, { recursive: true });
  const generationPrompt = composePrompt({
    prompt,
    width: desiredWidth,
    height: desiredHeight,
    targetFilename,
  });
  const startedAt = Date.now();
  const result = await runCodex({
    args: buildCodexArgs(generationPrompt),
    cwd: outputDirectory,
    timeoutMs: timeoutFromEnvironment(),
    startedAt,
  });

  let targetStatus = await generatedFileStatus(targetPath, result.startedAt);
  const staleTarget = targetStatus.exists && !targetStatus.fresh ? targetStatus : null;
  if (!targetStatus.fresh) {
    const fallback = await newestGeneratedPng(result.startedAt);
    if (fallback) {
      await moveFile(fallback, targetPath);
      console.warn(
        `Recovered image from the Codex session directory (${fallback}) and moved it to ${targetPath}.`,
      );
      targetStatus = await generatedFileStatus(targetPath, result.startedAt);
    }
  }

  if (!targetStatus.fresh) {
    throw new Error(failureMessage(result, targetPath, staleTarget));
  }
  if (result.timedOut) {
    throw new Error(`Codex timed out, but a fresh image exists at ${targetPath}; inspect it before use.`);
  }
  if (result.code !== 0) {
    throw new Error(
      `Codex produced ${targetPath} but exited with code ${result.code}.\n`
        + `stdout tail:\n${result.stdout || '(empty)'}\n\nstderr tail:\n${result.stderr || '(empty)'}`,
    );
  }

  return {
    provider: 'codex',
    outputPath: targetPath,
    width: desiredWidth,
    height: desiredHeight,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
