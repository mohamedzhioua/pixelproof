/**
 * The run directory: create, record, transition, finalise, read, enumerate
 * (ADR 0009 §2, ADR 0014).
 *
 * `run.json` is the single source of truth for whether a run is open. Everything
 * else in the directory is evidence *about* the run; nothing else decides its
 * state, and there is no index anywhere in the root — an index is a second thing
 * that can disagree with the truth (ADR 0009 §2).
 *
 * Three habits in here are deliberate and worth not undoing:
 *
 * - **Every write is atomic.** A temp file plus a rename, so a process killed
 *   mid-write leaves the previous good `run.json` rather than half of the next
 *   one. Evidence that can be truncated by a `Ctrl-C` is not evidence.
 * - **Every state change goes through `state.mjs`.** No function here assigns
 *   `state` directly, so an illegal transition is impossible to express rather
 *   than merely discouraged.
 * - **Every recorded path is relative to the run directory** (ADR 0014 §2), so a
 *   run directory can be archived or mounted elsewhere and still read. The one
 *   exception is a verbatim nested record such as `verification`, which keeps
 *   whatever its producer put in it.
 *
 * Nothing here imports a provider, a judge, or a surface, and nothing here knows
 * what a judge is. ADR 0009's handoff is built *on* this module; the state value
 * `pending-judgement` and the reserved round filenames are the only trace of it.
 */

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { RunError } from './errors.mjs';
import { ATTEMPT_SCHEMA, REPORT_SCHEMA, RUN_SCHEMA, assertSchema } from './envelope.mjs';
import { assertRunId, isRunId, newRunId } from './id.mjs';
import { buildReport, renderReportMarkdown } from './report.mjs';
import { describeRunRoot, resolveRunDirectory, resolveRunRoot } from './root.mjs';
import {
  ACCEPTED,
  INITIAL_STATE,
  TERMINAL_STATES,
  acceptedFor,
  assertOpen,
  assertTransition,
  isTerminalState,
} from './state.mjs';

/** Filenames inside a run directory (ADR 0014 §5). */
export const RUN_FILE = 'run.json';
export const REPORT_JSON_FILE = 'report.json';
export const REPORT_MARKDOWN_FILE = 'report.md';

/** How many times `createRun` re-rolls the random suffix on a collision. */
const CREATE_ATTEMPTS = 8;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Envelope paths are POSIX-separated so they read the same on either platform. */
function toEnvelopePath(relative) {
  return relative.split(path.sep).join('/');
}

function nowIso(now) {
  if (now === undefined) return new Date().toISOString();
  const date = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(date.getTime())) throw new TypeError('run timestamps must be a valid Date');
  return date.toISOString();
}

/** JSON as it is written to disk: 2-space indent, trailing newline. */
export function serialiseJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Write via a temp file in the same directory, then rename over the target.
 * Same-directory keeps the rename on one filesystem, which is what makes it
 * atomic; `rename` replaces an existing file on both POSIX and Windows.
 *
 * Exported so ADR 0009's round files are written the same way, from one
 * implementation. Evidence that a `Ctrl-C` can truncate is not evidence, and
 * that has to be true of every file in the directory, not just of `run.json`.
 */
export async function writeAtomic(file, contents) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${randomUUID()}`);
  try {
    await writeFile(temporary, contents);
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function sha256Of(file) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

/** The five verification fields ADR 0014 §2 guarantees, plus useful extras. */
function summariseVerification(verification) {
  if (!isPlainObject(verification)) {
    throw new TypeError('recordAttempt requires a verification record');
  }
  return {
    ok: typeof verification.ok === 'boolean' ? verification.ok : null,
    passed: Number.isInteger(verification.passed) ? verification.passed : 0,
    failed: Number.isInteger(verification.failed) ? verification.failed : 0,
    skipped: Number.isInteger(verification.skipped) ? verification.skipped : 0,
    strict: verification.strict === true,
    degraded: verification.degraded === true,
    decoder: typeof verification.decoder === 'string' ? verification.decoder : null,
  };
}

/** Field order is fixed so successive writes diff cleanly. */
function runDocument({
  runId,
  state,
  createdAt,
  updatedAt,
  pixelproofVersion,
  command,
  resolved,
  attempts,
  outcome,
  reasons,
  notes,
  extra,
}) {
  return {
    schema: RUN_SCHEMA,
    runId,
    state,
    accepted: acceptedFor(state),
    createdAt,
    updatedAt,
    pixelproofVersion,
    command,
    resolved,
    attempts,
    outcome,
    reasons,
    notes,
    // Unknown fields from a newer build survive a read/write cycle rather than
    // being silently dropped (ADR 0014 §4).
    ...extra,
  };
}

const OWNED_RUN_KEYS = new Set([
  'schema', 'runId', 'state', 'accepted', 'createdAt', 'updatedAt',
  'pixelproofVersion', 'command', 'resolved', 'attempts', 'outcome', 'reasons', 'notes',
]);

function unownedKeys(document) {
  const extra = {};
  for (const [key, value] of Object.entries(document)) {
    if (!OWNED_RUN_KEYS.has(key)) extra[key] = value;
  }
  return extra;
}

export function runFilePath(directory) {
  return path.join(directory, RUN_FILE);
}

/** `attempt-3` — the stem both the artifact and its record share. */
export function attemptStem(number) {
  if (!Number.isInteger(number) || number < 1) {
    throw new TypeError('attempt numbers start at 1');
  }
  return `attempt-${number}`;
}

/**
 * Create a run directory and its `run.json`.
 *
 * The directory is created non-recursively so an id collision surfaces as
 * `EEXIST` instead of quietly adopting somebody else's run directory — the same
 * instinct as ADR 0008's refusal to adopt a file it did not write. On collision
 * the random half of the id is re-rolled.
 *
 * @param {{
 *   runDir?: string|null, env?: object, cwd?: string, root?: string,
 *   now?: Date, suffix?: string, command?: string|null,
 *   resolved?: object, pixelproofVersion?: string|null, notes?: string[]
 * }} [options]
 */
export async function createRun({
  runDir,
  env,
  cwd,
  root,
  now,
  suffix,
  command = null,
  resolved = {},
  pixelproofVersion = null,
  notes = [],
} = {}) {
  const rootInfo = typeof root === 'string' && root.trim() !== ''
    ? { path: path.resolve(root), source: 'option' }
    : describeRunRoot({ runDir, env, cwd });

  await mkdir(rootInfo.path, { recursive: true });

  const createdAt = nowIso(now);
  let lastError = null;

  for (let attempt = 0; attempt < CREATE_ATTEMPTS; attempt += 1) {
    const runId = newRunId({ now: new Date(createdAt), suffix });
    const directory = resolveRunDirectory({ runId, root: rootInfo.path }).directory;

    try {
      await mkdir(directory);
    } catch (error) {
      if (error?.code === 'EEXIST' && suffix === undefined) {
        lastError = error;
        continue;
      }
      throw error;
    }

    const document = runDocument({
      runId,
      state: INITIAL_STATE,
      createdAt,
      updatedAt: createdAt,
      pixelproofVersion,
      command,
      resolved: isPlainObject(resolved) ? resolved : {},
      attempts: [],
      outcome: null,
      reasons: [],
      notes: Array.isArray(notes) ? [...notes] : [],
      extra: {},
    });

    await writeAtomic(runFilePath(directory), serialiseJson(document));

    return {
      runId,
      directory,
      root: rootInfo.path,
      rootSource: rootInfo.source,
      run: document,
    };
  }

  throw new RunError('RUN_FOREIGN_ROOT', `Could not create a unique run directory under ${rootInfo.path}`, {
    details: { root: rootInfo.path, attempts: CREATE_ATTEMPTS, code: lastError?.code ?? null },
  });
}

/**
 * Read a run back.
 *
 * The directory basename must be a well-formed run id and must equal the
 * `runId` inside the file. A record that disagrees with the directory holding it
 * cannot say which of the two is right, and ADR 0008's lesson is that a run
 * which cannot prove identity does not get to guess.
 */
export async function readRun(directory) {
  if (typeof directory !== 'string' || directory.trim() === '') {
    throw new RunError('RUN_NOT_FOUND', 'readRun requires a run directory path', { details: { directory: directory ?? null } });
  }

  const resolved = path.resolve(directory);
  const runId = assertRunId(path.basename(resolved));
  const file = runFilePath(resolved);

  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      throw new RunError('RUN_NOT_FOUND', `No readable ${RUN_FILE} in ${resolved}`, {
        details: { directory: resolved, file },
        cause: error,
      });
    }
    throw error;
  }

  let document;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    throw new RunError('RUN_SCHEMA_UNSUPPORTED', `${file} is not valid JSON`, {
      details: { directory: resolved, file },
      cause: error,
    });
  }

  assertSchema(document, RUN_SCHEMA, { file });

  if (document.runId !== runId) {
    throw new RunError('RUN_ID_MALFORMED', `${file} records run id ${JSON.stringify(document.runId ?? null)} but sits in ${runId}`, {
      details: { directory: resolved, recorded: document.runId ?? null, expected: runId },
    });
  }

  return document;
}

/** Read, mutate, write atomically. The only path by which `run.json` changes. */
async function updateRun(directory, mutate) {
  const resolved = path.resolve(directory);
  const current = await readRun(resolved);
  const next = mutate(current);
  await writeAtomic(runFilePath(resolved), serialiseJson(next));
  return next;
}

/**
 * Record one attempt: copy the artifact into the run directory, hash it, write
 * `attempt-<n>.json`, and append the summary to `run.json`.
 *
 * The hash is computed from the bytes in the run directory *after* the copy, not
 * from the source, so the digest describes the file a later reader will actually
 * open. Hashing the source and trusting the copy is how you end up with a
 * digest for bytes that no longer exist.
 *
 * @param {string} directory
 * @param {{
 *   artifact?: {path: string}|null, verification: object, semantic?: object|null,
 *   number?: number, copy?: boolean, now?: Date, notes?: string[]
 * }} options
 */
export async function recordAttempt(directory, {
  artifact = null,
  verification,
  semantic = null,
  number,
  copy = true,
  now,
  notes = [],
} = {}) {
  const resolved = path.resolve(directory);
  const current = await readRun(resolved);
  assertOpen(current.state, 'record an attempt');

  const attempts = Array.isArray(current.attempts) ? current.attempts : [];
  const next = number ?? attempts.length + 1;
  if (!Number.isInteger(next) || next < 1) {
    throw new TypeError('attempt numbers start at 1');
  }
  if (attempts.some((entry) => entry.number === next)) {
    throw new RunError('RUN_CLOSED', `Attempt ${next} is already recorded for ${current.runId}`, {
      details: { runId: current.runId, number: next },
    });
  }

  const recordedAt = nowIso(now);
  const stem = attemptStem(next);

  let artifactRecord = null;
  if (artifact !== null) {
    if (typeof artifact.path !== 'string' || artifact.path.trim() === '') {
      throw new TypeError('recordAttempt artifact requires a path');
    }
    const source = path.resolve(artifact.path);
    const target = copy
      ? path.join(resolved, `${stem}${path.extname(source) || '.bin'}`)
      : source;

    if (copy && path.resolve(target) !== source) {
      await copyFile(source, target);
    }

    const relative = path.relative(resolved, path.resolve(target));
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new RunError('RUN_FOREIGN_ROOT', `Attempt artifact ${target} is outside run directory ${resolved}`, {
        details: { directory: resolved, artifact: target },
      });
    }

    const stats = await stat(target);
    artifactRecord = {
      path: toEnvelopePath(relative),
      bytes: stats.size,
      sha256: await sha256Of(target),
    };
  }

  const attemptDocument = {
    schema: ATTEMPT_SCHEMA,
    runId: current.runId,
    number: next,
    recordedAt,
    artifact: artifactRecord,
    // Carried verbatim: this is the verifier's own record, not a shape this
    // module owns (ADR 0014 §3).
    verification,
    // Reserved for ADR 0009's recorded per-check verdicts.
    semantic,
  };

  const attemptFile = path.join(resolved, `${stem}.json`);
  await writeAtomic(attemptFile, serialiseJson(attemptDocument));

  const summary = {
    number: next,
    recordedAt,
    artifact: artifactRecord,
    verification: summariseVerification(verification),
    files: { verification: toEnvelopePath(path.relative(resolved, attemptFile)) },
  };

  const run = await updateRun(resolved, (document) => runDocument({
    runId: document.runId,
    state: document.state,
    createdAt: document.createdAt,
    updatedAt: recordedAt,
    pixelproofVersion: document.pixelproofVersion ?? null,
    command: document.command ?? null,
    resolved: document.resolved ?? {},
    attempts: [...(document.attempts ?? []), summary].sort((left, right) => left.number - right.number),
    outcome: document.outcome ?? null,
    reasons: document.reasons ?? [],
    notes: [...(document.notes ?? []), ...notes],
    extra: unownedKeys(document),
  }));

  return { run, attempt: attemptDocument, files: { attempt: attemptFile } };
}

/**
 * Merge reserved top-level fields into `run.json`, and optionally append a
 * reason and notes, without touching `state`.
 *
 * This is how ADR 0009 writes the `judge` and `rounds` keys that ADR 0014 §5
 * reserves for it, and how `judge submit` records a named refusal on a run that
 * stays open. Two guarantees survive:
 *
 * - **Owned keys are refused.** `state` and `accepted` in particular are not
 *   settable from here, so the module's rule that every state change goes
 *   through `state.mjs` is still impossible to express a way around rather than
 *   merely discouraged.
 * - **A closed run is not appended to.** A terminal run's directory is a record
 *   of what happened; writing into it afterwards would make the report describe
 *   something else.
 *
 * @param {string} directory
 * @param {{fields?: object, reason?: {code: string, message?: string}|null, notes?: string[]}} update
 * @param {{now?: Date}} [options]
 */
export async function recordRunFields(directory, { fields = {}, reason = null, notes = [] } = {}, { now } = {}) {
  if (!isPlainObject(fields)) throw new TypeError('recordRunFields requires an object of fields');

  const owned = Object.keys(fields).filter((key) => OWNED_RUN_KEYS.has(key));
  if (owned.length > 0) {
    throw new RunError('RUN_STATE_TRANSITION_REFUSED', `Refusing to set run-owned fields from outside the store: ${owned.join(', ')}`, {
      details: { fields: owned },
    });
  }

  const at = nowIso(now);
  return updateRun(directory, (document) => {
    assertOpen(document.state, 'record run fields');
    return runDocument({
      runId: document.runId,
      state: document.state,
      createdAt: document.createdAt,
      updatedAt: at,
      pixelproofVersion: document.pixelproofVersion ?? null,
      command: document.command ?? null,
      resolved: document.resolved ?? {},
      attempts: document.attempts ?? [],
      outcome: document.outcome ?? null,
      reasons: withReason(document.reasons ?? [], reason?.code ?? null, reason?.message, at),
      notes: [...(document.notes ?? []), ...notes],
      extra: { ...unownedKeys(document), ...fields },
    });
  });
}

/**
 * Record the semantic verdicts on an already-written attempt.
 *
 * `attempt-<n>.json` carries the mechanical table *and* the semantic verdicts
 * (ADR 0009 §2), but the two are produced at different times: the mechanical
 * table exists before the host is asked anything, and the verdicts arrive with a
 * submission that may be a day later. The attempt is not re-recorded — the
 * artifact and its digest describe the same bytes either way, and rewriting the
 * whole record would risk the hash and the file drifting apart.
 */
export async function recordAttemptSemantic(directory, number, semantic, { now } = {}) {
  const resolved = path.resolve(directory);
  const current = await readRun(resolved);
  assertOpen(current.state, 'record semantic verdicts');

  const file = path.join(resolved, `${attemptStem(number)}.json`);

  let document;
  try {
    document = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      throw new RunError('RUN_NOT_FOUND', `No ${attemptStem(number)}.json in ${resolved}`, {
        details: { directory: resolved, file, number },
        cause: error,
      });
    }
    throw error;
  }

  assertSchema(document, ATTEMPT_SCHEMA, { file });
  const next = { ...document, semantic, semanticRecordedAt: nowIso(now) };
  await writeAtomic(file, serialiseJson(next));
  return next;
}

/**
 * Read every attempt record the run names, for the report.
 *
 * ADR 0020 §7's report has to list each attempt "with its mechanical table and
 * its verdicts", and both live in `attempt-<n>.json` rather than in `run.json`'s
 * summary. The reading happens here so `buildReport` stays pure.
 *
 * A record that is missing or corrupt is reported as unreadable rather than
 * dropped, and never blocks finalisation: a run that could not reach a terminal
 * state because one evidence file is damaged would be a worse failure than a
 * report that says which file it could not read.
 */
async function readAttemptDetails(directory, attempts) {
  const details = {};
  for (const entry of attempts) {
    if (!Number.isInteger(entry?.number)) continue;
    const file = path.join(directory, `${attemptStem(entry.number)}.json`);
    try {
      details[entry.number] = JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      details[entry.number] = {
        unreadable: error?.code === 'ENOENT' || error?.code === 'ENOTDIR'
          ? `${attemptStem(entry.number)}.json is missing`
          : `${attemptStem(entry.number)}.json could not be read: ${error.message}`,
      };
    }
  }
  return details;
}

/** Append a named reason to the run record. Codes are stable; prose is not. */
function withReason(reasons, code, message, at) {
  if (code === null || code === undefined) return reasons;
  return [...reasons, { code, message: message ?? null, at }];
}

/**
 * Move the run to another state. Non-terminal moves only — finishing a run goes
 * through `finaliseRun`, because a terminal state and its report are one act.
 *
 * @param {string} directory
 * @param {string} to
 * @param {{reason?: {code: string, message?: string}|null, now?: Date}} [options]
 */
export async function transitionRun(directory, to, { reason = null, now } = {}) {
  if (isTerminalState(to)) {
    throw new RunError('RUN_STATE_TRANSITION_REFUSED', `Use finaliseRun to move a run to ${to} so its report is written with it`, {
      details: { to, terminal: [...TERMINAL_STATES] },
    });
  }

  const at = nowIso(now);
  return updateRun(directory, (document) => {
    assertTransition(document.state, to);
    return runDocument({
      runId: document.runId,
      state: to,
      createdAt: document.createdAt,
      updatedAt: at,
      pixelproofVersion: document.pixelproofVersion ?? null,
      command: document.command ?? null,
      resolved: document.resolved ?? {},
      attempts: document.attempts ?? [],
      outcome: document.outcome ?? null,
      reasons: withReason(document.reasons ?? [], reason?.code ?? null, reason?.message, at),
      notes: document.notes ?? [],
      extra: unownedKeys(document),
    });
  });
}

/**
 * Finish a run: transition to a terminal state, then write `report.json` and
 * `report.md`.
 *
 * Both reports are written on abandonment as well as on acceptance (ADR 0009
 * §2). The run record is written first and the reports are derived from it, so
 * the reports can never claim something `run.json` does not.
 *
 * @param {string} directory
 * @param {{
 *   state: string, reason?: string|{code: string, message?: string}|null,
 *   acceptedAttempt?: number|null, now?: Date
 * }} options
 */
export async function finaliseRun(directory, { state, reason = null, acceptedAttempt = null, now } = {}) {
  const resolved = path.resolve(directory);
  if (!isTerminalState(state)) {
    throw new RunError('RUN_STATE_TRANSITION_REFUSED', `finaliseRun requires a terminal state, got ${JSON.stringify(state ?? null)}`, {
      details: { state: state ?? null, terminal: [...TERMINAL_STATES] },
    });
  }

  const at = nowIso(now);
  const reasonCode = typeof reason === 'string' ? reason : reason?.code ?? null;
  const reasonMessage = typeof reason === 'string' ? null : reason?.message ?? null;

  const run = await updateRun(resolved, (document) => {
    assertTransition(document.state, state);

    const attempts = document.attempts ?? [];
    let accepted = null;
    if (state === ACCEPTED) {
      accepted = Number.isInteger(acceptedAttempt)
        ? acceptedAttempt
        : attempts.length > 0 ? attempts[attempts.length - 1].number : null;
      if (accepted !== null && !attempts.some((entry) => entry.number === accepted)) {
        throw new RunError('RUN_NOT_FOUND', `Cannot accept attempt ${accepted}: it was never recorded`, {
          details: { runId: document.runId, acceptedAttempt: accepted },
        });
      }
    } else if (Number.isInteger(acceptedAttempt)) {
      throw new RunError('RUN_STATE_TRANSITION_REFUSED', `A ${state} run cannot name an accepted attempt`, {
        details: { state, acceptedAttempt },
      });
    }

    return runDocument({
      runId: document.runId,
      state,
      createdAt: document.createdAt,
      updatedAt: at,
      pixelproofVersion: document.pixelproofVersion ?? null,
      command: document.command ?? null,
      resolved: document.resolved ?? {},
      attempts,
      outcome: { state, reason: reasonCode, acceptedAttempt: accepted, finalisedAt: at },
      reasons: withReason(document.reasons ?? [], reasonCode, reasonMessage, at),
      notes: document.notes ?? [],
      extra: unownedKeys(document),
    });
  });

  const report = buildReport(run, {
    schema: REPORT_SCHEMA,
    generatedAt: at,
    attemptDetails: await readAttemptDetails(resolved, run.attempts ?? []),
  });
  const reportJson = path.join(resolved, REPORT_JSON_FILE);
  const reportMarkdown = path.join(resolved, REPORT_MARKDOWN_FILE);

  await writeAtomic(reportJson, serialiseJson(report));
  await writeAtomic(reportMarkdown, renderReportMarkdown(report));

  return { run, report, files: { report: reportJson, narrative: reportMarkdown } };
}

/** Read a finalised `report.json` back, refusing an unsupported envelope. */
export async function readReport(directory) {
  const resolved = path.resolve(directory);
  const file = path.join(resolved, REPORT_JSON_FILE);

  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      throw new RunError('RUN_NOT_FOUND', `No ${REPORT_JSON_FILE} in ${resolved}; the run is not finalised`, {
        details: { directory: resolved, file },
        cause: error,
      });
    }
    throw error;
  }

  let document;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    throw new RunError('RUN_SCHEMA_UNSUPPORTED', `${file} is not valid JSON`, { details: { file }, cause: error });
  }

  assertSchema(document, REPORT_SCHEMA, { file });
  return document;
}

/**
 * Enumerate runs by scanning every `<root>/<runId>/run.json`, newest first.
 *
 * No index file, by ADR 0009 §2. Sorting is lexicographic on the id, which is
 * chronological because the id starts with a fixed-width UTC timestamp — that
 * property is exactly why the id format is what it is.
 *
 * A directory whose `run.json` is missing, corrupt, or written by a newer major
 * is **listed with its error**, not skipped. ADR 0014 §7 expects a repository to
 * hold several majors at once, and a run that silently vanishes from the listing
 * is worse than one that says it cannot be read. Directories whose names are not
 * run ids are ignored entirely: they were never ours.
 *
 * @returns {Promise<Array<{runId: string, directory: string, state: string|null, run: object|null, error: {code: string, message: string}|null}>>}
 */
export async function listRuns({ runDir, env, cwd, root } = {}) {
  const resolvedRoot = typeof root === 'string' && root.trim() !== ''
    ? path.resolve(root)
    : resolveRunRoot({ runDir, env, cwd });

  let entries;
  try {
    entries = await readdir(resolvedRoot, { withFileTypes: true });
  } catch (error) {
    // A root that has never been written is "no runs", not a failure.
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return [];
    throw error;
  }

  const runs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!isRunId(entry.name)) continue;

    const directory = path.join(resolvedRoot, entry.name);
    try {
      const run = await readRun(directory);
      runs.push({ runId: run.runId, directory, state: run.state, run, error: null });
    } catch (error) {
      if (!(error instanceof RunError)) throw error;
      runs.push({
        runId: entry.name,
        directory,
        state: null,
        run: null,
        error: { code: error.code, message: error.message },
      });
    }
  }

  runs.sort((left, right) => (left.runId < right.runId ? 1 : left.runId > right.runId ? -1 : 0));
  return runs;
}

/** Open runs, in ADR 0009's sense: anything not in a terminal state. */
export async function listOpenRuns(options = {}) {
  const runs = await listRuns(options);
  return runs.filter((entry) => entry.state !== null && !isTerminalState(entry.state));
}
