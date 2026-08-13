/**
 * Where run directories live (ADR 0009 "Consequences", ADR 0014 §5).
 *
 * `.pixelproof/runs/` under the working directory by default, overridable by
 * `--run-dir` (passed in as `runDir`) or `PIXELPROOF_RUN_ROOT` so CI can place
 * the evidence on a retained path. Explicit flag beats environment beats
 * default, which is the ordering every other option in this tool uses.
 *
 * Nothing here creates a directory. Resolution is a pure question and is asked
 * on paths that may not exist — `listRuns` on a repository that has never run a
 * judge must answer "none", not "cannot".
 */

import path from 'node:path';

import { RunError } from './errors.mjs';
import { assertRunId } from './id.mjs';

/** The run root, relative to the working directory, when nothing overrides it. */
export const DEFAULT_RUN_ROOT = path.join('.pixelproof', 'runs');

/** The environment variable that overrides the default. */
export const RUN_ROOT_ENV = 'PIXELPROOF_RUN_ROOT';

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * @param {{runDir?: string|null, env?: Record<string, string|undefined>, cwd?: string}} [options]
 * @returns {{path: string, source: 'option'|'env'|'default'}}
 */
export function describeRunRoot({ runDir, env = process.env, cwd = process.cwd() } = {}) {
  if (nonEmptyString(runDir)) {
    return { path: path.resolve(cwd, runDir), source: 'option' };
  }

  const fromEnv = env?.[RUN_ROOT_ENV];
  if (nonEmptyString(fromEnv)) {
    return { path: path.resolve(cwd, fromEnv), source: 'env' };
  }

  return { path: path.resolve(cwd, DEFAULT_RUN_ROOT), source: 'default' };
}

/** The resolved absolute run root. */
export function resolveRunRoot(options = {}) {
  return describeRunRoot(options).path;
}

/**
 * Whether `candidate` is `root` itself or sits underneath it. Decided from
 * `path.relative` output rather than from a string prefix, so a sibling named
 * `runs-evil` is not mistaken for a child of `runs`.
 */
export function containsPath(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === '') return true;
  return !path.isAbsolute(relative) && !relative.split(path.sep).includes('..');
}

/**
 * Turn a run id into the directory it names, refusing anything that is not a
 * well-formed id and anything that would land outside the root.
 *
 * The regex check happens before the join and the containment check happens
 * after it — ADR 0009 §3 asks for both, and they fail differently on purpose:
 * a malformed id is a caller mistake, an escape is an attempt.
 */
export function resolveRunDirectory({ runId, root, runDir, env, cwd } = {}) {
  assertRunId(runId);
  const resolvedRoot = nonEmptyString(root)
    ? path.resolve(root)
    : resolveRunRoot({ runDir, env, cwd });

  const directory = path.resolve(resolvedRoot, runId);
  if (!containsPath(resolvedRoot, directory) || path.dirname(directory) !== resolvedRoot) {
    throw new RunError('RUN_FOREIGN_ROOT', `Run directory for ${runId} is not contained in the run root`, {
      details: { runId, root: resolvedRoot, directory },
    });
  }

  return { root: resolvedRoot, directory, runId };
}

/**
 * Guard for a directory handed in from elsewhere: it must be a direct child of
 * the root and its basename must be a well-formed run id.
 */
export function assertRunDirectory({ directory, root, runDir, env, cwd } = {}) {
  if (!nonEmptyString(directory)) {
    throw new RunError('RUN_NOT_FOUND', 'A run directory path is required', { details: { directory: directory ?? null } });
  }
  const resolved = path.resolve(directory);
  const runId = path.basename(resolved);
  const known = resolveRunDirectory({
    runId,
    root: nonEmptyString(root) ? root : path.dirname(resolved),
    runDir,
    env,
    cwd,
  });

  if (path.resolve(known.directory) !== resolved) {
    throw new RunError('RUN_FOREIGN_ROOT', `Run directory ${resolved} is not contained in ${known.root}`, {
      details: { directory: resolved, root: known.root },
    });
  }

  return known;
}
