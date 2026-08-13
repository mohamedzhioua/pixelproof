/**
 * Generic subprocess adapter transport (ADR 0004, ADR 0007).
 *
 * External adapters are untrusted executables. This module is the only place
 * that talks to them, and it is deliberately vendor-neutral: it knows how to
 * spawn a process, hand it one JSON request on stdin, read one JSON reply from
 * stdout, and destroy the whole process tree if it misbehaves. It knows nothing
 * about what the adapter generates or judges.
 *
 * Every rule here is a containment rule:
 *
 * - No shell, ever. The command and its arguments are an argv array, so no
 *   quoting, globbing, or metacharacter interpretation can happen. A prompt is
 *   data, never shell source.
 * - stdin is written once and closed. An adapter blocked on a stdin that never
 *   ends is the most common hang on Windows.
 * - stdout and stderr are bounded independently. stdout carries the protocol
 *   reply and is capped at MAX_RESPONSE_BYTES; stderr is diagnostic and only a
 *   MAX_LOG_BYTES tail is retained. A flooding adapter is killed, not buffered.
 * - The deadline terminates the process *tree*. A timeout that leaves
 *   grandchildren running is not a timeout.
 * - The environment is an allowlist. Secrets are never forwarded implicitly.
 * - Every failure lands on the closed taxonomy in `./../contracts/errors.mjs`.
 *   An adapter cannot widen the set of codes a caller must handle.
 *
 * `core/` never imports from `scripts/`, `providers/`, or `surfaces/`.
 */

import { spawn } from 'node:child_process';

import { AdapterError, normalizeErrorPayload } from '../contracts/errors.mjs';
import {
  DESCRIBE_REQUEST,
  MAX_LOG_BYTES,
  MAX_RESPONSE_BYTES,
  PROTOCOL_VERSION,
  validateManifest,
} from '../contracts/provider.mjs';

/** Deadline applied when a caller does not supply one. */
export const DEFAULT_TIMEOUT_MS = 300_000;

/** SIGTERM-to-SIGKILL grace period for a process group that will not leave. */
export const DEFAULT_KILL_GRACE_MS = 2_000;

/**
 * How long to wait for `close` after ordering a kill before giving up on the
 * pipes and settling anyway. A process wedged in uninterruptible state must not
 * wedge the caller with it.
 */
const FORCED_SETTLE_MS = 5_000;

/**
 * Environment variables forwarded so the OS can execute a process at all. This
 * is the entire implicit surface; everything else must be named by the caller.
 */
const OS_ENV_NAMES = process.platform === 'win32'
  ? Object.freeze(['PATH', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'COMSPEC', 'windir'])
  : Object.freeze(['PATH']);

function internal(message, details, cause) {
  return new AdapterError('INTERNAL', message, { details: details ?? null, cause });
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Resolve an environment variable by name, case-insensitively on Windows, where
 * `PATH` and `Path` are the same variable but not the same object key.
 */
function readEnvVar(source, name) {
  if (Object.hasOwn(source, name)) return source[name];
  if (process.platform !== 'win32') return undefined;
  const wanted = name.toLowerCase();
  for (const key of Object.keys(source)) {
    if (key.toLowerCase() === wanted) return source[key];
  }
  return undefined;
}

/**
 * Build the child environment from an explicit allowlist plus the OS minimum.
 * `env` entries are literal values supplied by the caller; `envAllowlist` names
 * variables copied from this process. Nothing else crosses the boundary.
 */
export function buildEnvironment({ envAllowlist = [], env = {}, source = process.env } = {}) {
  const result = Object.create(null);

  for (const name of OS_ENV_NAMES) {
    const value = readEnvVar(source, name);
    if (typeof value === 'string') result[name] = value;
  }

  if (!Array.isArray(envAllowlist) || envAllowlist.some((name) => typeof name !== 'string')) {
    throw new AdapterError('INVALID_REQUEST', 'envAllowlist must be an array of variable names', {
      retryable: false,
    });
  }
  for (const name of envAllowlist) {
    const value = readEnvVar(source, name);
    if (typeof value === 'string') result[name] = value;
  }

  if (!isPlainObject(env)) {
    throw new AdapterError('INVALID_REQUEST', 'env must be a JSON object of literal values', {
      retryable: false,
    });
  }
  for (const [name, value] of Object.entries(env)) {
    if (typeof value === 'string') result[name] = value;
  }

  return result;
}

function normalizeConfig(raw) {
  const config = isPlainObject(raw) ? raw : {};

  if (typeof config.command !== 'string' || config.command.trim() === '') {
    throw new AdapterError('INVALID_REQUEST', 'Adapter config requires a command path', {
      retryable: false,
    });
  }
  const args = config.args === undefined || config.args === null ? [] : config.args;
  if (!Array.isArray(args) || args.some((entry) => typeof entry !== 'string')) {
    // An argv array is the security boundary; a single string would invite a shell.
    throw new AdapterError('INVALID_REQUEST', 'Adapter config args must be an array of strings', {
      retryable: false,
    });
  }

  const timeoutMs = positiveIntegerOr(config.timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs');
  return {
    command: config.command,
    args: [...args],
    cwd: typeof config.cwd === 'string' && config.cwd !== '' ? config.cwd : process.cwd(),
    timeoutMs,
    killGraceMs: positiveIntegerOr(config.killGraceMs, DEFAULT_KILL_GRACE_MS, 'killGraceMs'),
    maxResponseBytes: positiveIntegerOr(config.maxResponseBytes, MAX_RESPONSE_BYTES, 'maxResponseBytes'),
    maxLogBytes: positiveIntegerOr(config.maxLogBytes, MAX_LOG_BYTES, 'maxLogBytes'),
    env: buildEnvironment(config),
  };
}

function positiveIntegerOr(value, fallback, label) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value <= 0) {
    throw new AdapterError('INVALID_REQUEST', `${label} must be a positive integer when present`, {
      retryable: false,
    });
  }
  return value;
}

function signalGroup(child, signal) {
  const { pid } = child;
  if (!pid) return;
  try {
    // Negative pid signals the whole group, which only exists because the child
    // was spawned detached. Signalling the child alone would orphan its children.
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

/**
 * Terminate the child and everything it started. Windows has no process groups
 * to signal, so the tree is walked by `taskkill /T /F`; Unix signals the process
 * group and escalates SIGTERM to SIGKILL after a grace period.
 */
function terminateTree(child, killGraceMs) {
  if (!child.pid) return;

  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.on('error', () => {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
      });
      killer.unref();
    } catch {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }
    return;
  }

  signalGroup(child, 'SIGTERM');
  const escalation = setTimeout(() => signalGroup(child, 'SIGKILL'), killGraceMs);
  escalation.unref();
}

/**
 * Spawn the adapter, exchange one message, and return the raw outcome. Resolves
 * for every process-level result — including timeout and flood — so the caller
 * owns all taxonomy mapping in one place. Only spawn failure rejects.
 */
function exchangeRaw(config, message) {
  const payload = `${JSON.stringify(message)}\n`;

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(config.command, config.args, {
        cwd: config.cwd,
        env: config.env,
        // No `shell`. Ever. See the module header.
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        // A process group on Unix is what makes tree termination possible.
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      reject(spawnFailure(error, config));
      return;
    }

    const startedAt = Date.now();
    const stdoutChunks = [];
    let stdoutBytes = 0;
    let stderrTail = Buffer.alloc(0);
    let outcome = 'closed';
    let settled = false;
    let forcedTimer = null;

    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (forcedTimer) clearTimeout(forcedTimer);
      resolve(result);
    };

    const finish = () => {
      settle({
        outcome,
        stdout: Buffer.concat(stdoutChunks),
        stderr: stderrTail.toString('utf8'),
        exitCode: null,
        signal: null,
        durationMs: Date.now() - startedAt,
      });
    };

    const abort = (reason) => {
      if (settled || outcome !== 'closed') return;
      outcome = reason;
      terminateTree(child, config.killGraceMs);
      // If the pipes never close (a wedged descendant holding them), settle anyway.
      forcedTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        finish();
      }, FORCED_SETTLE_MS);
      forcedTimer.unref?.();
    };

    const deadline = setTimeout(() => abort('timeout'), config.timeoutMs);

    child.stdout.on('data', (chunk) => {
      if (outcome !== 'closed') return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > config.maxResponseBytes) {
        // Keep nothing further; the reply is already void and memory is the point.
        abort('flood');
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr.on('data', (chunk) => {
      stderrTail = Buffer.concat([stderrTail, chunk]);
      if (stderrTail.length > config.maxLogBytes) {
        stderrTail = stderrTail.subarray(stderrTail.length - config.maxLogBytes);
      }
    });

    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});
    // An adapter may exit without reading its request; EPIPE is its problem, not a crash.
    child.stdin.on('error', () => {});

    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (forcedTimer) clearTimeout(forcedTimer);
      reject(spawnFailure(error, config));
    });

    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (forcedTimer) clearTimeout(forcedTimer);
      resolve({
        outcome,
        stdout: Buffer.concat(stdoutChunks),
        stderr: stderrTail.toString('utf8'),
        exitCode: code,
        signal,
        durationMs: Date.now() - startedAt,
      });
    });

    try {
      child.stdin.end(payload);
    } catch {
      /* the error handler above already covers a dead pipe */
    }
  });
}

function spawnFailure(error, config) {
  const code = error?.code;
  if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM' || code === 'ENOTDIR') {
    return new AdapterError(
      'PROVIDER_UNAVAILABLE',
      `Adapter executable could not be started: ${config.command} (${code})`,
      { retryable: false, details: { command: config.command, code: code ?? null }, cause: error },
    );
  }
  return internal(
    `Failed to start adapter executable: ${error?.message ?? String(error)}`,
    { command: config.command, code: code ?? null },
    error,
  );
}

/**
 * Find the protocol reply in stdout. Adapters legitimately log, and they log
 * both before and after the reply, so the last parseable JSON object wins with
 * a preference for one that declares a protocol. Scanning backwards keeps a
 * chatty adapter from breaking a well-formed reply.
 */
export function extractReply(stdout) {
  const text = typeof stdout === 'string' ? stdout : stdout.toString('utf8');
  const lines = text.split(/\r?\n/u);
  let fallback = null;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (line === '' || !line.startsWith('{')) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isPlainObject(parsed)) continue;
    if (Object.hasOwn(parsed, 'protocol')) return parsed;
    if (fallback === null) fallback = parsed;
  }

  return fallback;
}

function logDetails(result) {
  return {
    exitCode: result.exitCode,
    signal: result.signal,
    stderr: result.stderr === '' ? null : result.stderr,
  };
}

/**
 * Send one message to an adapter and return its reply.
 *
 * Resolves with `{ response, stderr, exitCode, signal, durationMs }` where
 * `response` is the adapter's own JSON object. Rejects with an `AdapterError`
 * whose code is always inside the closed taxonomy: a well-formed `ok: false`
 * payload keeps its own (narrowed) code, a deadline is TIMEOUT, a missing
 * executable is PROVIDER_UNAVAILABLE, and anything unparseable, oversized, or
 * absent is INTERNAL.
 */
export async function exchange(rawConfig, message) {
  if (!isPlainObject(message)) {
    throw new AdapterError('INVALID_REQUEST', 'Adapter message must be a JSON object', {
      retryable: false,
    });
  }
  const config = normalizeConfig(rawConfig);
  const result = await exchangeRaw(config, message);

  if (result.outcome === 'timeout') {
    throw new AdapterError(
      'TIMEOUT',
      `Adapter exceeded its ${config.timeoutMs}ms deadline and its process tree was terminated`,
      { details: { ...logDetails(result), timeoutMs: config.timeoutMs } },
    );
  }

  if (result.outcome === 'flood') {
    throw internal(
      `Adapter wrote more than ${config.maxResponseBytes} bytes to stdout and was terminated`,
      { ...logDetails(result), maxResponseBytes: config.maxResponseBytes },
    );
  }

  const response = extractReply(result.stdout);
  if (response === null) {
    throw internal('Adapter produced no parseable JSON reply on stdout', logDetails(result));
  }
  if (response.protocol !== PROTOCOL_VERSION) {
    throw internal(
      `Adapter replied with protocol ${JSON.stringify(response.protocol ?? null)}, but this build speaks protocol ${PROTOCOL_VERSION}`,
      logDetails(result),
    );
  }

  if (response.ok === false) {
    const normalized = normalizeErrorPayload(response.error, {
      fallbackMessage: 'Adapter reported a failure without a message',
    });
    throw new AdapterError(normalized.code, normalized.message, {
      retryable: normalized.retryable,
      details: { ...logDetails(result), reported: normalized.details },
    });
  }

  return {
    response,
    stderr: result.stderr,
    exitCode: result.exitCode,
    signal: result.signal,
    durationMs: result.durationMs,
  };
}

/**
 * Handshake: ask an adapter what it can do and return its validated manifest.
 * Both reply shapes are accepted — the manifest inline, or wrapped under a
 * `manifest` key — because the contract fixes the manifest's meaning, not its
 * envelope.
 */
export async function describe(config) {
  const { response } = await exchange(config, DESCRIBE_REQUEST);
  const candidate = isPlainObject(response.manifest)
    ? { protocol: PROTOCOL_VERSION, ...response.manifest }
    : response;
  return validateManifest(candidate);
}

/**
 * Perform one operation (generate, judge, or any future verb). This module does
 * not interpret the request or the reply beyond the envelope; the caller owns
 * the operation-specific contract.
 */
export async function run(config, request) {
  if (!isPlainObject(request)) {
    throw new AdapterError('INVALID_REQUEST', 'Adapter request must be a JSON object', {
      retryable: false,
    });
  }
  const message = request.protocol === undefined
    ? { protocol: PROTOCOL_VERSION, ...request }
    : request;
  return exchange(config, message);
}
