/**
 * Codex: a trusted built-in provider adapter (ADR 0004, ADR 0005).
 *
 * Trusted means imported in-process, not spawned through the untrusted
 * subprocess transport — it ships in this repository and runs with this
 * process's authority by design. It still exercises a child process, because
 * the Codex CLI is one, but that is an implementation detail of this adapter
 * rather than the adapter boundary.
 *
 * Two things moved out of the old script and into structure:
 *
 * - The accepted output geometry is now a capability record on the manifest, so
 *   `core`'s generic `preflight()` enforces it. Nothing here re-implements a
 *   bounds check, which is what makes the same rules apply whether the size came
 *   from `--size`, a spec, or the default.
 * - Freshness now runs through `core/artifacts/provenance.mjs`, so the direct
 *   target and a recovered session image are judged by one helper rather than
 *   two lookalike ones.
 *
 * `assertCodexSize` and `generateWithCodex` are the frozen v1 surface (ADR
 * 0003). Their wording and behaviour are characterized by tests and must not
 * drift; that is why the legacy entry point deliberately does not preflight —
 * v1 never did, and callers pass sizes it would reject.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  adoptArtifact,
  collectFreshArtifacts,
  prepareTarget,
  runReference,
  selectArtifact,
  validateTarget,
} from '../core/artifacts/provenance.mjs';
import { AdapterError } from '../core/contracts/errors.mjs';
import {
  PROTOCOL_VERSION,
  preflight,
  validateGenerateRequest,
  validateManifest,
} from '../core/contracts/provider.mjs';

const DEFAULT_TIMEOUT_MS = 300_000;
const OUTPUT_TAIL_LENGTH = 4_000;

/**
 * gpt-image-2's accepted output geometry. These are vendor facts, so they live
 * with the vendor (ADR 0002) — but as declared data on the manifest, not as a
 * bespoke validator. Each number is the one v1 enforced in `assertCodexSize`.
 */
export const CODEX_DIMENSION_MULTIPLE = 16;
export const CODEX_MAX_EDGE = 3840;
export const CODEX_MIN_PIXELS = 655_360;
export const CODEX_MAX_PIXELS = 8_294_400;
export const CODEX_MAX_ASPECT_RATIO = 3;

export const id = 'codex';

export const manifest = validateManifest({
  protocol: PROTOCOL_VERSION,
  id,
  kinds: ['raster'],
  capabilities: {
    maxWidth: CODEX_MAX_EDGE,
    maxHeight: CODEX_MAX_EDGE,
    dimensionMultiple: CODEX_DIMENSION_MULTIPLE,
    minPixels: CODEX_MIN_PIXELS,
    maxPixels: CODEX_MAX_PIXELS,
    maxAspectRatio: CODEX_MAX_ASPECT_RATIO,
    // No minimum edge is declared because v1 never enforced one; the pixel floor
    // and the ratio ceiling already bound how small an edge can get.
    seed: false,
    references: false,
    transparency: false,
    negativePrompt: false,
  },
});

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

/**
 * Restate a capability violation in v1's wording.
 *
 * The *decision* to reject is `preflight`'s alone — this only formats what it
 * decided, from the same capability record, so there is no second set of
 * thresholds that could drift from the manifest. The wording is frozen public
 * surface (ADR 0003) and is pinned by the compatibility tests.
 */
function legacySizeViolations(size) {
  const { capabilities } = manifest;
  const totalPixels = size.width * size.height;
  const longToShortRatio = Math.max(size.width, size.height) / Math.min(size.width, size.height);
  const violations = [];

  if (totalPixels < capabilities.minPixels) {
    violations.push(
      `total pixel count ${totalPixels} is below the minimum total pixel count ${capabilities.minPixels}`,
    );
  }
  if (totalPixels > capabilities.maxPixels) {
    violations.push(
      `total pixel count ${totalPixels} exceeds the maximum total pixel count ${capabilities.maxPixels}`,
    );
  }
  if (size.width > capabilities.maxWidth) {
    violations.push(`width ${size.width} exceeds the maximum edge length ${capabilities.maxWidth}`);
  }
  if (size.height > capabilities.maxHeight) {
    violations.push(`height ${size.height} exceeds the maximum edge length ${capabilities.maxHeight}`);
  }
  if (size.width % capabilities.dimensionMultiple !== 0) {
    violations.push(`width ${size.width} is not a multiple of ${capabilities.dimensionMultiple}`);
  }
  if (size.height % capabilities.dimensionMultiple !== 0) {
    violations.push(`height ${size.height} is not a multiple of ${capabilities.dimensionMultiple}`);
  }
  if (longToShortRatio > capabilities.maxAspectRatio) {
    violations.push(
      `long-to-short ratio ${longToShortRatio.toFixed(4)} exceeds the maximum `
        + `${capabilities.maxAspectRatio}:1 ratio`,
    );
  }

  return violations;
}

/**
 * Reject a requested size the provider cannot honour before spending a call on
 * it. Every violation is reported at once: fixing one edge only to be told
 * about the other is a needless round trip.
 */
export function assertCodexSize(size) {
  const request = validateGenerateRequest({
    protocol: PROTOCOL_VERSION,
    kind: 'raster',
    prompt: 'capability preflight',
    out: 'capability-preflight.png',
    width: positiveInteger(size?.width, 'width'),
    height: positiveInteger(size?.height, 'height'),
  });

  try {
    preflight(manifest, request);
  } catch (error) {
    const violations = legacySizeViolations(size);
    throw new Error(
      `--size ${size.width}x${size.height} cannot be honoured by gpt-image-2: `
        + (violations.length > 0 ? violations.join('; ') : error.message),
    );
  }
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

/**
 * Locate the Codex CLI on PATH. Windows needs the explicit filename walk
 * because a `.cmd`/`.ps1` shim is not directly spawnable the way an `.exe` is.
 * Returns null rather than throwing so detection and invocation can share it.
 */
function findWindowsCodexCommand() {
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
  return null;
}

function resolveWindowsCodexCommand() {
  const found = findWindowsCodexCommand();
  if (!found) throw new Error('Codex CLI is not installed or is not available on PATH');
  return found;
}

/**
 * Is the provider usable at all? Read-only, no network, no paid call — this is
 * what `doctor` and discovery are allowed to ask. Being on PATH is availability,
 * not authentication; this deliberately does not claim the user is logged in.
 */
export function detect() {
  if (process.platform === 'win32') {
    return { available: findWindowsCodexCommand() !== null, reason: 'codex was not found on PATH' };
  }

  const directories = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const directory of directories) {
    if (existsSync(path.join(directory.replace(/^"|"$/g, ''), 'codex'))) {
      return { available: true, reason: null };
    }
  }
  return { available: false, reason: 'codex was not found on PATH' };
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

function generatedImagesDirectory() {
  const codexHome = process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(os.homedir(), '.codex');
  return path.join(codexHome, 'generated_images');
}

function isPng({ name }) {
  return name.toLowerCase().endsWith('.png');
}

/**
 * The message for an unprovable recovery (ADR 0008).
 *
 * Every fresh PNG under `$CODEX_HOME/generated_images` is equally plausible as
 * this run's output: Codex writes into a per-session directory whose name it
 * does not report back in any form this adapter can rely on — the transcript is
 * unstructured and kept only as a bounded tail — so there is nothing to
 * correlate a file to a session with. "Newest wins" was therefore a guess, and a
 * guess that lands on another run's image reports success on the wrong asset,
 * silently. This message replaces that guess.
 *
 * It names every candidate because the user, unlike the adapter, can often tell
 * which is which, and because the paths are the evidence that a second run was
 * in flight. Nothing is moved or deleted on this path: the files stay where
 * Codex put them.
 */
function ambiguousRecoveryMessage(candidates, recoveryRoot, notBefore) {
  const listed = candidates
    .map((candidate) => `  - ${candidate.path} (modified "${new Date(candidate.mtimeMs).toISOString()}")`)
    .join('\n');
  return `Ambiguous image recovery: ${candidates.length} images under ${recoveryRoot} were created `
    + `after this run started ("${new Date(notBefore).toISOString()}"), and Codex does not report `
    + `which session directory was this run's, so none of them can be proven to belong to it.\n`
    + `Candidates (newest first):\n${listed}\n`
    + `This usually means another Codex or Pixelproof run shared this CODEX_HOME. `
    + `No file was moved, adopted, or deleted; re-run when no other run is in flight.`;
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

/**
 * The whole run, once. Both entry points share this so the freshness and
 * recovery rules cannot differ between the legacy path and the contract path.
 *
 * @param {{prompt: string, outPath: string, width: number, height: number,
 *          timeoutMs?: number|null, onWarning?: (message: string) => void}} options
 */
async function runCodexGeneration({ prompt, outPath, width, height, timeoutMs = null, onWarning }) {
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    throw new Error('The Codex provider requires a non-empty prompt');
  }
  const desiredWidth = positiveInteger(width, 'width');
  const desiredHeight = positiveInteger(height, 'height');
  if (path.extname(path.basename(path.resolve(outPath))).toLowerCase() !== '.png') {
    throw new Error('The Codex raster provider requires a .png output path');
  }

  const target = await prepareTarget(outPath);
  // The recovery scan reads Codex's own session directory, which is under
  // $CODEX_HOME and need not share a filesystem with the output directory. A
  // run-start reference is only comparable to mtimes stamped by the same
  // filesystem, so that directory gets its own sample, taken here — before the
  // run — rather than borrowed from the target. If it does not exist yet
  // (Codex has never produced an image) there is nothing to sample and nothing
  // to recover; the target's reference is the fallback, which is exactly the
  // behaviour that shipped.
  const recoveryRoot = generatedImagesDirectory();
  const recovery = await runReference(recoveryRoot, { fallback: target.startedAt });
  const generationPrompt = composePrompt({
    prompt,
    width: desiredWidth,
    height: desiredHeight,
    targetFilename: target.filename,
  });
  const result = await runCodex({
    args: buildCodexArgs(generationPrompt),
    cwd: target.directory,
    timeoutMs: timeoutMs ?? timeoutFromEnvironment(),
    startedAt: target.startedAt,
  });

  let status = await validateTarget(target);
  // Captured before any recovery: a pre-existing file is only interesting as the
  // reason a run failed, and it is never overwritten unless a *proven fresh*
  // artifact replaces it below.
  const staleTarget = status.exists && !status.fresh ? status : null;

  if (!status.fresh) {
    const candidates = await collectFreshArtifacts({
      roots: [recoveryRoot],
      notBefore: recovery.ms,
      accept: isPng,
    });
    // `reject`, not `newest`: with more than one fresh candidate this run cannot
    // prove which file is its own, and an unprovable artifact is not an
    // artifact (ADR 0008).
    //
    // What this buys and what it does not, precisely:
    // - It eliminates silent cross-adoption. A run can no longer finish with
    //   another run's image at its output path while reporting success.
    // - It does NOT make concurrent runs sharing a CODEX_HOME work. Both runs
    //   now fail rather than one of them succeeding wrongly. That is the trade,
    //   and it is the right way round: a failure is retryable, a wrong image
    //   that has been "verified" is not detectable downstream.
    //
    // The narrowness matters for compatibility: this branch is only reachable
    // when the target was not written directly and the scan found two or more
    // fresh files — exactly the case where the old code guessed. Every path
    // where v1 had a provable answer (direct write, single candidate, no
    // candidate) behaves as it always did.
    const chosen = selectArtifact(candidates, { policy: 'reject' });
    if (chosen.ambiguous) {
      throw new Error(ambiguousRecoveryMessage(chosen.candidates, recoveryRoot, recovery.ms));
    }
    if (chosen.path) {
      status = await adoptArtifact({ source: chosen.path, target });
      onWarning(
        `Recovered image from the Codex session directory (${chosen.path}) and moved it to ${target.path}.`,
      );
    }
  }

  if (!status.fresh) {
    throw new Error(failureMessage(result, target.path, staleTarget));
  }
  if (result.timedOut) {
    throw new Error(`Codex timed out, but a fresh image exists at ${target.path}; inspect it before use.`);
  }
  if (result.code !== 0) {
    throw new Error(
      `Codex produced ${target.path} but exited with code ${result.code}.\n`
        + `stdout tail:\n${result.stdout || '(empty)'}\n\nstderr tail:\n${result.stderr || '(empty)'}`,
    );
  }

  return { target, result, width: desiredWidth, height: desiredHeight };
}

/**
 * v1 entry point. Frozen shape, frozen messages, warnings on the console — and
 * no capability preflight, because v1 had none here and its callers rely on
 * that (`scripts/generate.mjs` preflights a `--size` itself, and only that).
 */
export async function generateWithCodex({ prompt, outPath, width, height }) {
  const { target, result } = await runCodexGeneration({
    prompt,
    outPath,
    width,
    height,
    onWarning: (message) => console.warn(message),
  });

  return {
    provider: id,
    outputPath: target.path,
    width: positiveInteger(width, 'width'),
    height: positiveInteger(height, 'height'),
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/**
 * Contract entry point (ADR 0005). Takes a protocol request, enforces the
 * manifest through the generic preflight, and answers with a protocol response.
 * Warnings are returned rather than printed: a provider does not own a console.
 */
export async function generate(rawRequest) {
  const request = validateGenerateRequest(rawRequest);
  preflight(manifest, request);

  if (request.width === null || request.height === null) {
    // Preflight skips geometry when none was requested; this adapter cannot,
    // because the prompt has to state a size. Inventing a default here would
    // hide the caller's omission behind a picture of the wrong shape.
    throw new AdapterError(
      'INVALID_REQUEST',
      `Provider "${id}" requires both width and height`,
      { retryable: false, details: { width: request.width, height: request.height } },
    );
  }

  const warnings = [];
  const startedAt = Date.now();

  try {
    const { target, result } = await runCodexGeneration({
      prompt: request.prompt,
      outPath: request.out,
      width: request.width,
      height: request.height,
      timeoutMs: request.timeoutMs,
      onWarning: (message) => warnings.push(message),
    });

    return {
      protocol: PROTOCOL_VERSION,
      ok: true,
      file: target.path,
      provider: id,
      model: process.env.PIXELPROOF_CODEX_MODEL ?? null,
      durationMs: Date.now() - startedAt,
      warnings,
      meta: { exitCode: result.code, timedOut: result.timedOut },
    };
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    const timedOut = /timed out/i.test(error?.message ?? '');
    throw new AdapterError(
      timedOut ? 'TIMEOUT' : 'INTERNAL',
      error?.message ?? String(error),
      { details: { provider: id }, cause: error },
    );
  }
}
