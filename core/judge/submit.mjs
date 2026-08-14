/**
 * Resuming a pending run: find it, prove it, combine it, decide it
 * (ADR 0009 §1, §3, §5).
 *
 * Two rules shape everything here.
 *
 * **Resume records verdicts; it does not re-run the run.** Nothing in this file
 * regenerates an artifact or re-runs a tier. Mechanical results are
 * deterministic over the same bytes and are already evidenced in the run
 * directory. Regenerating on resume would produce a *different* artifact than
 * the one the host actually looked at, leaving verdicts that describe bytes
 * which no longer exist — the precise failure this project exists to prevent.
 *
 * **A missing verdict is never a pass.** There is no path below on which an
 * absent, refused, expired, or errored submission produces `accepted`. The
 * refusals are named, recorded, and exit non-zero; the only route to acceptance
 * is a submission that satisfied every check in §3 and every assertion in the
 * checklist.
 */

import { stat } from 'node:fs/promises';
import path from 'node:path';

import { acceptanceFor, combineVerdicts, parseJudgeResponse } from '../contracts/judge.mjs';
import { assertRunId } from '../run/id.mjs';
import { resolveRunDirectory } from '../run/root.mjs';
import { PENDING_JUDGEMENT, RUNNING, isTerminalState } from '../run/state.mjs';
import { listRuns, readRun } from '../run/store.mjs';
import { hasExpired } from './deadline.mjs';
import { PendingError, asPendingError } from './errors.mjs';
import { nonceMatches, sha256OfFile } from './digest.mjs';
import { MAX_ROUNDS, readPendingRecord } from './pending.mjs';

/** Reasons a run is finalised, recorded in `run.json` and printed by the report. */
export const OUTCOME_REASONS = Object.freeze({
  accepted: 'semantic-passed',
  semanticFailed: 'semantic-failed',
  semanticUnsure: 'semantic-unsure',
  judgeError: 'judge-error',
  mechanicalFailed: 'mechanical-failed',
  expired: 'judgement-abandoned',
  abandoned: 'judgement-abandoned',
  awaiting: 'awaiting-host-judgement',
  nothingDeclared: 'no-semantic-assertions',
  // ADR 0020 §2. `retakeAvailable` is the one reason recorded on a run that is
  // still open: the attempt was rejected and the next one has not started.
  retakeAvailable: 'retake-available',
  exhausted: 'retakes-exhausted',
});

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The round still awaiting an answer: the last one nobody has submitted to. */
export function openRoundOf(run) {
  const rounds = Array.isArray(run?.rounds) ? run.rounds : [];
  for (let index = rounds.length - 1; index >= 0; index -= 1) {
    if (rounds[index]?.submittedAt == null) return rounds[index];
  }
  return null;
}

/**
 * Where a round sits inside its own attempt (ADR 0020 §5).
 *
 * Round numbers run across the whole run — attempt 2 starts at round 3 — but ADR
 * 0009 §5's bound of two rounds is *per attempt*, so escalation has to count
 * within the attempt rather than within the run. A round summary written before
 * ADR 0020 records no `attempt`; for those the two numberings coincide, which is
 * why the fallback is the round number itself rather than a guess.
 */
export function roundInAttempt(run, round) {
  const rounds = Array.isArray(run?.rounds) ? run.rounds : [];
  const entry = rounds.find((candidate) => candidate?.round === round) ?? null;
  if (entry === null || !Number.isInteger(entry.attempt)) return round;

  const siblings = rounds
    .filter((candidate) => candidate?.attempt === entry.attempt)
    .map((candidate) => candidate.round)
    .sort((left, right) => left - right);
  const position = siblings.indexOf(round);
  return position === -1 ? round : position + 1;
}

/** The highest round number issued so far, or 0 when none has been. */
export function lastRoundOf(run) {
  const rounds = Array.isArray(run?.rounds) ? run.rounds : [];
  return rounds.reduce((highest, entry) => (
    Number.isInteger(entry?.round) && entry.round > highest ? entry.round : highest
  ), 0);
}

/**
 * Every run currently waiting on a host, newest first, with its open round.
 *
 * A pending run whose round file cannot be read is **listed with its error**
 * rather than dropped, for the same reason `listRuns` lists an unreadable run:
 * a pending judgement that silently vanishes from `judge pending` is worse than
 * one that says it cannot be read, because the first looks like "nothing is
 * outstanding".
 */
export async function listPendingRuns(options = {}) {
  const runs = await listRuns(options);
  const pending = [];

  for (const entry of runs) {
    if (entry.state !== PENDING_JUDGEMENT) continue;
    const round = openRoundOf(entry.run);
    let record = null;
    let error = null;
    if (round !== null) {
      try {
        record = await readPendingRecord(entry.directory, round.round);
      } catch (caught) {
        if (!(caught instanceof PendingError)) throw caught;
        error = { code: caught.code, message: caught.message };
      }
    } else {
      error = {
        code: 'PENDING_NOT_FOUND',
        message: `${entry.runId} is pending-judgement but records no open round`,
      };
    }
    pending.push({ ...entry, round, record, error });
  }

  return pending;
}

/**
 * Every run that is open but has nothing outstanding: `running`, with at least
 * one attempt recorded (ADR 0020's orphan).
 *
 * This is the state a retake leaves behind when an operator never continues and
 * never abandons. It is invisible to `judge pending` — correctly, because
 * nothing is pending — which is exactly why it has to be visible somewhere else.
 * ADR 0009 §4's guarantee is that an abandoned handoff is visible to someone who
 * never knew one happened, and it would quietly stop being true for the retake
 * path if nobody counted these.
 *
 * "With at least one attempt" is the whole definition. A `running` run with no
 * attempt is either a generation in flight right now or one that died before it
 * produced anything; neither is a judgement anyone is waiting on.
 */
export async function listStalledRuns(options = {}) {
  const runs = await listRuns(options);
  return runs.filter((entry) => (
    entry.state === RUNNING && Array.isArray(entry.run?.attempts) && entry.run.attempts.length > 0
  ));
}

/**
 * Resolve `--run` to a run that can be closed on the record.
 *
 * Wider than `selectPendingRun` on purpose: ADR 0020 requires `judge abandon` to
 * reach a run left in `running` between attempts, or such a run would have no
 * way to be closed at all. It is not wider than that — a terminal run is still
 * refused, because a closed run is already on the record.
 *
 * Nothing is discarded by closing a `running` run: verdicts are written before
 * the run ever leaves `pending-judgement`, so a run that is closable mid-retake
 * has already recorded everything anyone submitted. A run whose round is still
 * *unanswered* is a different case and stays exactly as it was — abandoning it
 * is ADR 0009 §4's explicit "an unanswered checklist is never a pass", and the
 * report says so.
 */
export async function selectClosableRun({ runId = null, root, runDir, env, cwd } = {}) {
  if (typeof runId === 'string' && runId.trim() !== '') {
    let directory;
    try {
      assertRunId(runId);
      directory = resolveRunDirectory({ runId, root, runDir, env, cwd }).directory;
    } catch (error) {
      throw asPendingError(error, { runId });
    }

    let run;
    try {
      run = await readRun(directory);
    } catch (error) {
      throw asPendingError(error, { runId, directory });
    }

    if (isTerminalState(run.state)) {
      throw new PendingError('PENDING_NOT_OPEN', `Run ${runId} is already ${run.state}; a closed run is on the record`, {
        details: { runId, directory, state: run.state },
      });
    }

    return { runId, directory, run, round: openRoundOf(run), record: null };
  }

  const candidates = [
    ...await listPendingRuns({ root, runDir, env, cwd }),
    ...await listStalledRuns({ root, runDir, env, cwd }),
  ];

  if (candidates.length === 0) {
    throw new PendingError('PENDING_NOT_FOUND', 'No run is open', { details: { candidates: [] } });
  }
  if (candidates.length > 1) {
    throw new PendingError(
      'PENDING_NOT_OPEN',
      `${candidates.length} runs are open; name one with --run: ${candidates.map((entry) => entry.runId).join(', ')}`,
      { details: { candidates: candidates.map((entry) => entry.runId) } },
    );
  }

  return selectClosableRun({ runId: candidates[0].runId, root, runDir, env, cwd });
}

/**
 * Resolve `--run` to an open pending run.
 *
 * The regex check happens before any path is built from the value and the
 * containment check happens after the join, so `--run ../../etc` is refused
 * rather than followed (ADR 0009 §3). Both are delegated to the run store,
 * which already enforces them, and re-expressed in this layer's vocabulary.
 */
export async function openPendingRun({ runId, root, runDir, env, cwd } = {}) {
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

  if (run.state !== PENDING_JUDGEMENT) {
    throw new PendingError('PENDING_NOT_OPEN', `Run ${runId} is ${run.state}, not ${PENDING_JUDGEMENT}`, {
      details: { runId, directory, state: run.state },
    });
  }

  const round = openRoundOf(run);
  if (round === null) {
    throw new PendingError('PENDING_NOT_OPEN', `Run ${runId} is ${PENDING_JUDGEMENT} but records no open round`, {
      details: { runId, directory },
    });
  }

  const record = await readPendingRecord(directory, round.round);
  return { runId, directory, run, round, record };
}

/**
 * `--run` may be omitted only when exactly one pending run is open (ADR 0009
 * §3). Two or more is refused, naming each candidate.
 *
 * This is the same rule and the same reasoning as `selectArtifact(…, { policy:
 * 'reject' })`: a run that cannot prove which pending record is its own does not
 * get to guess. ADR 0008 was written because guessing once already adopted a
 * foreign file.
 */
export async function selectPendingRun({ runId = null, root, runDir, env, cwd } = {}) {
  if (typeof runId === 'string' && runId.trim() !== '') {
    return openPendingRun({ runId, root, runDir, env, cwd });
  }

  const pending = await listPendingRuns({ root, runDir, env, cwd });
  if (pending.length === 0) {
    throw new PendingError('PENDING_NOT_FOUND', 'No run is waiting on a host judgement', {
      details: { candidates: [] },
    });
  }
  if (pending.length > 1) {
    throw new PendingError(
      'PENDING_NOT_OPEN',
      `${pending.length} runs are waiting on a host judgement; name one with --run: ${pending.map((entry) => entry.runId).join(', ')}`,
      { details: { candidates: pending.map((entry) => entry.runId) } },
    );
  }

  return openPendingRun({ runId: pending[0].runId, root, runDir, env, cwd });
}

/**
 * Shape-check a submission before any of it is believed.
 *
 * `response` is left alone here: it is validated by `parseJudgeResponse()`
 * against the exact ids that were asked, which is the contract's job and not
 * this module's to duplicate.
 */
export function parseSubmission(raw) {
  if (!isPlainObject(raw)) {
    throw new PendingError('PENDING_SCHEMA_UNSUPPORTED', 'A submission must be a JSON object', {
      details: { received: raw === null ? 'null' : typeof raw },
    });
  }
  if (!isPlainObject(raw.response)) {
    throw new PendingError('PENDING_SCHEMA_UNSUPPORTED', 'A submission must carry a `response` object', {
      details: { keys: Object.keys(raw) },
    });
  }
  return {
    runId: typeof raw.runId === 'string' ? raw.runId : null,
    nonce: typeof raw.nonce === 'string' ? raw.nonce : null,
    checksDigest: typeof raw.checksDigest === 'string' ? raw.checksDigest : null,
    round: Number.isInteger(raw.round) ? raw.round : null,
    response: raw.response,
  };
}

/**
 * The four content refusals, in ADR 0009 §3's table order.
 *
 * Identity is proven **before** expiry is considered, and that ordering is
 * deliberate: finalising a run as rejected on the strength of a submission that
 * could not prove it owned the run would let any passer-by close somebody
 * else's pending judgement. A stranger's expired submission is refused as a
 * nonce mismatch and the run stays open for whoever actually holds the nonce —
 * or for `judge abandon`.
 *
 * @returns {Promise<{response: object}>} the validated judge response
 */
export async function verifySubmission({ record, round, submission, directory, now = new Date() }) {
  if (submission.runId !== null && submission.runId !== record.runId) {
    throw new PendingError(
      'PENDING_ID_MALFORMED',
      `Submission echoes run ${JSON.stringify(submission.runId)}, but this pending record is ${record.runId}`,
      { details: { submitted: submission.runId, expected: record.runId } },
    );
  }
  if (submission.round !== null && submission.round !== record.round) {
    throw new PendingError(
      'PENDING_NOT_OPEN',
      `Submission answers round ${submission.round}, but round ${record.round} is the open one`,
      { details: { submitted: submission.round, open: record.round } },
    );
  }
  if (!nonceMatches(submission.nonce ?? '', record.nonce)) {
    throw new PendingError(
      'PENDING_NONCE_MISMATCH',
      'Submission nonce is absent or does not match this pending record; '
        + `read it from judge-request-${record.round}.json`,
      { details: { runId: record.runId, round: record.round } },
    );
  }
  if (submission.checksDigest !== record.checksDigest) {
    throw new PendingError(
      'PENDING_CHECKS_MISMATCH',
      'Submission checksDigest differs from the pending record: the spec moved under the host',
      { details: { submitted: submission.checksDigest, expected: record.checksDigest } },
    );
  }
  if (hasExpired(record.expiresAt, now)) {
    throw new PendingError(
      'PENDING_EXPIRED',
      `This judgement expired at ${record.expiresAt}; expiry is a verdict about the process, never about the artifact`,
      { details: { runId: record.runId, expiresAt: record.expiresAt } },
    );
  }

  const artifact = path.resolve(directory, record.artifact.path);
  let actual = null;
  try {
    await stat(artifact);
    actual = await sha256OfFile(artifact);
  } catch (error) {
    if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
  }
  if (actual !== record.artifact.sha256) {
    throw new PendingError(
      'ARTIFACT_CHANGED',
      actual === null
        ? `The judged artifact is gone from ${artifact}`
        : 'The judged artifact no longer hashes to the value recorded when the checklist was issued',
      { details: { artifact, expected: record.artifact.sha256, actual } },
    );
  }

  // Validated against the exact ids that were asked. A partial answer silently
  // treated as complete is indistinguishable from a pass (ADR 0010), so a
  // missing or extra result is a protocol violation, not a tolerance.
  const response = parseJudgeResponse(submission.response, {
    expectedIds: round.checks ?? record.request.checks.map((check) => check.id),
  });

  return { response };
}

/**
 * Fold a round's verdicts into the authoritative per-check table.
 *
 * ADR 0009 §5: **a round-2 host verdict replaces the escalated verdict for that
 * check; it does not join the panel for it.** Under the default `all` policy,
 * joining would leave round-1 `unsure` combined with round-2 `pass` as `unsure`
 * forever, so escalation would resolve nothing. Replacement is what makes the
 * host the escalation *authority*, and `escalatedFrom` records that it happened
 * so the report can say so rather than quietly showing the newer verdict.
 */
export function foldVerdicts({ prior = [], record, response, policy = 'all' }) {
  const byId = new Map(prior.map((entry) => [entry.id, entry]));
  const assertions = new Map(record.request.checks.map((check) => [check.id, check.assertion]));

  for (const result of response.results) {
    const previous = byId.get(result.id) ?? null;
    const combined = combineVerdicts([result.verdict], policy);
    byId.set(result.id, {
      id: result.id,
      assertion: assertions.get(result.id) ?? previous?.assertion ?? null,
      verdict: combined.verdict,
      confidence: result.confidence,
      evidence: result.evidence,
      round: record.round,
      judge: response.judge ?? record.judge,
      disagreement: combined.disagreement,
      escalatedFrom: previous === null ? null : { round: previous.round, verdict: previous.verdict },
    });
  }

  // Ordered by the checklist the run started from, so a report reads in spec
  // order rather than in whatever order a judge happened to answer.
  const ordered = [];
  for (const entry of prior) if (byId.has(entry.id)) ordered.push(byId.get(entry.id));
  for (const [id, entry] of byId) if (!ordered.some((seen) => seen.id === id)) ordered.push(entry);
  return ordered;
}

/**
 * Turn the authoritative table into what happens next.
 *
 * A `fail` anywhere ends the run even when another check is `unsure`: escalating
 * a run that is already rejected spends a host round to change nothing. Semantic
 * assertions are hard gates (ADR 0011), so no count of passes offsets one
 * failure.
 *
 * `round` here is the round's position **within its attempt**, not its run-wide
 * number (ADR 0020 §5). Attempt 2's first round is run round 3 and attempt
 * round 1, and it is entitled to its own escalation; passing the run-wide number
 * would silently deny every attempt after the first the escalation ADR 0009 §5
 * grants it. Callers get the right value from `roundInAttempt(run, round)`.
 */
export function decideOutcome({ checks, onUnsure = 'escalate', round = 1 }) {
  const failing = checks.filter((check) => check.verdict === 'fail');
  if (failing.length > 0) {
    return {
      outcome: 'rejected',
      reason: OUTCOME_REASONS.semanticFailed,
      checks: failing.map((check) => check.id),
    };
  }

  const unsure = checks.filter((check) => check.verdict === 'unsure');
  if (unsure.length > 0) {
    const { escalate } = acceptanceFor('unsure', { onUnsure });
    if (escalate && round < MAX_ROUNDS) {
      return { outcome: 'escalate', reason: null, checks: unsure.map((check) => check.id) };
    }
    return {
      outcome: 'rejected',
      reason: OUTCOME_REASONS.semanticUnsure,
      checks: unsure.map((check) => check.id),
    };
  }

  return { outcome: 'accepted', reason: OUTCOME_REASONS.accepted, checks: [] };
}
