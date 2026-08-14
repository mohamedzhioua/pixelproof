/**
 * The retake bound and the refusals that guard it (ADR 0020).
 *
 * A retake is a new numbered attempt **inside the same run directory** — not a
 * new run and not a chain of linked runs. Everything about attempt *n* stays
 * immutable: its bytes, its mechanical table, its verdicts and its round files.
 * Attempt *n+1* occupies a new numbered slot and touches none of them, which is
 * why re-opening `pending-judgement -> running` does not raise the hazard ADR
 * 0009 §1 closed that edge against.
 *
 * This module is the half a state machine cannot express. `core/run/state.mjs`
 * can say "this pair is legal"; it cannot say "only while the bound is unspent,
 * only for a new attempt number, and only when nobody is still waiting on a
 * checklist". Those three are here, in one place, so `judge submit` and
 * `pixelproof retake` reach the same answer rather than agreeing by coincidence.
 *
 * Nothing here generates, and nothing here decides whether an image is any good.
 */

import { PENDING_JUDGEMENT, RUNNING } from '../run/state.mjs';
import { readRun } from '../run/store.mjs';
import { assertRunId } from '../run/id.mjs';
import { resolveRunDirectory } from '../run/root.mjs';
import { PendingError, asPendingError } from './errors.mjs';
import { openRoundOf } from './submit.mjs';

/**
 * The bound when nobody asked for one: a single attempt, which is exactly what
 * every invocation does today (ADR 0020 §6). It is deliberately **not** the 3
 * the example spec carries, because honouring `spec.retakes` unconditionally
 * would turn one paid call into three for every existing caller with a spec.
 */
export const DEFAULT_RETAKES = 1;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Read a retake bound from one source, refusing anything that is not a whole
 * number of attempts. A bound of 0 is refused rather than read as "no
 * generations": a run that produces nothing is a mistake, not a configuration.
 */
function parseBound(value, source) {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`${source} must be a whole number of attempts, 1 or more, not ${JSON.stringify(value)}`);
  }
  return number;
}

/**
 * Resolve the bound for a new run: `--retakes` wins, then `spec.retakes`, then
 * one (ADR 0020 §6).
 *
 * **`spec.retakes` is honoured only inside a judged run.** Without `--judge`,
 * `generate` makes exactly one provider call and behaves byte-identically, and
 * `--retakes` is refused the way `--judge-deadline` already is. That is not
 * tidiness: the example spec and the skills both carry `"retakes": 3`, so
 * reading the field unconditionally would silently triple what every existing
 * caller with a spec spends — a documented-semantic change ADR 0003 does not
 * permit.
 *
 * The spec field is validated here rather than in `assertV1Spec` for the same
 * reason: a spec that a bare `generate` accepts today must keep being accepted,
 * and this path is only reachable with `--judge`.
 *
 * @param {{option?: string|number|null, spec?: object|null, judged: boolean}} input
 */
export function resolveRetakeBound({ option = null, spec = null, judged }) {
  if (!judged) {
    if (option !== null && option !== undefined) {
      throw new Error('--retakes only means something with --judge; a bare generate makes exactly one attempt');
    }
    return DEFAULT_RETAKES;
  }

  if (option !== null && option !== undefined) return parseBound(option, '--retakes');

  const declared = isPlainObject(spec) ? spec.retakes : undefined;
  if (declared === undefined || declared === null) return DEFAULT_RETAKES;
  return parseBound(declared, 'spec.retakes');
}

/** The bound a run was opened with, as recorded in its `resolved` block. */
export function boundOf(run) {
  const declared = run?.resolved?.retakes;
  return Number.isInteger(declared) && declared >= 1 ? declared : DEFAULT_RETAKES;
}

/** Attempts already recorded against the run. */
export function attemptsOf(run) {
  return Array.isArray(run?.attempts) ? run.attempts : [];
}

/** The number attempt *n+1* would take: contiguous, 1-based (ADR 0014 §2). */
export function nextAttemptNumber(run) {
  return attemptsOf(run).length + 1;
}

/** How many attempts the bound still permits. Never negative. */
export function retakesLeft(run) {
  return Math.max(0, boundOf(run) - attemptsOf(run).length);
}

/**
 * Whether the bound permits another attempt. Deliberately separate from
 * `assertRetakeable`: `judge submit` needs the boolean to decide whether to
 * finalise or leave the run open, and it must not have to catch an exception to
 * learn a fact.
 */
export function hasRetakeLeft(run) {
  return retakesLeft(run) > 0;
}

/**
 * Refuse a run that must not be retaken, with the named reason ADR 0020 §3
 * defines.
 *
 * Openness is checked before the bound, because a terminal run whose bound is
 * also spent is refused for the more fundamental of the two facts: it is closed.
 * Reporting `RETAKE_EXHAUSTED` there would invite the operator to raise the
 * bound and try again on a run that can never accept another attempt.
 */
export function assertRetakeable(run, { runId = null, directory = null } = {}) {
  const details = { runId: runId ?? run?.runId ?? null, directory, state: run?.state ?? null };

  if (run?.state !== RUNNING) {
    const because = run?.state === PENDING_JUDGEMENT
      ? 'answer or abandon the outstanding judgement first'
      : 'a closed run is never reopened';
    throw new PendingError(
      'RETAKE_NOT_OPEN',
      `Run ${details.runId} is ${run?.state ?? 'unreadable'}, not ${RUNNING}: ${because}`,
      { details },
    );
  }

  // A run in `running` should have no open round, but a crash between writing a
  // checklist and recording the state can leave one. Generating over it would
  // orphan a checklist somebody may still be answering.
  const open = openRoundOf(run);
  if (open !== null) {
    throw new PendingError(
      'RETAKE_NOT_OPEN',
      `Run ${details.runId} still has round ${open.round} outstanding; answer or abandon it first`,
      { details: { ...details, round: open.round } },
    );
  }

  if (!isPlainObject(run.judge)) {
    throw new PendingError(
      'RETAKE_NOT_OPEN',
      `Run ${details.runId} asked for no judge; there is no rejected judgement to correct`,
      { details },
    );
  }

  if (attemptsOf(run).length === 0) {
    throw new PendingError(
      'RETAKE_NOT_OPEN',
      `Run ${details.runId} has recorded no attempt yet; there is nothing to correct`,
      { details },
    );
  }

  if (!hasRetakeLeft(run)) {
    throw new PendingError(
      'RETAKE_EXHAUSTED',
      `Run ${details.runId} has spent its retake bound of ${boundOf(run)}; nothing is promoted on exhaustion`,
      { details: { ...details, retakes: boundOf(run), attempts: attemptsOf(run).length } },
    );
  }

  return run;
}

/**
 * Resolve `--run` to a run that may be retaken.
 *
 * The shape mirrors `openPendingRun`: the id is checked before any path is built
 * from it and the containment check happens after the join, both delegated to
 * the run store and re-expressed in this layer's vocabulary (ADR 0009 §3). The
 * four id and envelope refusals are reused unchanged — same mechanism, same
 * names — because none of them is new (ADR 0020 §3).
 */
export async function openRetakeableRun({ runId, root, runDir, env, cwd } = {}) {
  let directory;
  try {
    assertRunId(runId);
    directory = resolveRunDirectory({ runId, root, runDir, env, cwd }).directory;
  } catch (error) {
    throw asPendingError(error, { runId: runId ?? null });
  }

  let run;
  try {
    run = await readRun(directory);
  } catch (error) {
    throw asPendingError(error, { runId, directory });
  }

  assertRetakeable(run, { runId, directory });

  return { runId, directory, run, attempt: nextAttemptNumber(run) };
}
