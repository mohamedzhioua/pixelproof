/**
 * The handoff itself: issue a round, apply a submission, close a run
 * (ADR 0009 §1, §2, §4, §5).
 *
 * `host` is not a synchronous adapter and is not modelled as one. It is a **run
 * state**. Nothing in this module waits on a file, polls, or holds a process
 * open across the handoff: the first invocation writes a checklist and returns,
 * the second reads verdicts and finalises. That is the whole point — the agent
 * that ran `generate` is the only entity that can open the image, and it cannot
 * do so while blocked on the child process it spawned.
 *
 * The functions here are the policy. Presentation belongs to the surface, and
 * the surface is deliberately thin over them, so `pixelproof judge submit` and
 * any later MCP or library caller reach acceptance through the same code rather
 * than through two implementations that agree today.
 */

import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import {
  ACCEPTED,
  PENDING_JUDGEMENT,
  REJECTED,
  finaliseRun,
  recordAttemptSemantic,
  recordRunFields,
  transitionRun,
} from '../run/index.mjs';
import { DEFAULT_DEADLINE_MS, expiryFrom } from './deadline.mjs';
import { newNonce } from './digest.mjs';
import {
  HOST_JUDGE,
  buildPendingRecord,
  buildResultRecord,
  pendingRequestFile,
  pendingResultFile,
  writePendingRecord,
  writeResultRecord,
} from './pending.mjs';
import {
  OUTCOME_REASONS,
  decideOutcome,
  foldVerdicts,
} from './submit.mjs';

/** The default consensus policy (ADR 0010). A panel of one still routes through it. */
export const DEFAULT_POLICY = 'all';

function roundSummary(record, checks) {
  return {
    round: record.round,
    issuedAt: record.issuedAt,
    expiresAt: record.expiresAt,
    escalationTerminal: record.escalationTerminal,
    onUnsure: record.onUnsure,
    checks,
    submittedAt: null,
    files: { request: pendingRequestFile(record.round), result: null },
  };
}

/**
 * Open the first round: write `judge-request-1.json`, record it, and move the
 * run to `pending-judgement`.
 *
 * The order matters. The checklist is on disk *before* the state says a
 * checklist exists, so a process killed between the two leaves a run that is
 * still `running` with a stray request file — recoverable and obviously
 * incomplete — rather than a run that claims to be pending with nothing to
 * answer.
 */
export async function issueFirstRound(directory, {
  run,
  checks,
  artifactPath,
  artifactSha256,
  artifactBytes,
  context = null,
  specDigest = null,
  onUnsure = 'escalate',
  policy = DEFAULT_POLICY,
  deadlineMs = DEFAULT_DEADLINE_MS,
  pixelproofVersion = null,
  attempt = 1,
  now = new Date(),
}) {
  const issuedAt = now.toISOString();
  const record = buildPendingRecord({
    runId: run.runId,
    round: 1,
    checks,
    artifactPath,
    artifactSha256,
    artifactBytes,
    context,
    issuedAt,
    deadlineMs,
    pixelproofVersion,
    specDigest,
    onUnsure,
    nonce: newNonce(),
    escalationTerminal: false,
  });

  const file = await writePendingRecord(directory, record);

  await recordRunFields(directory, {
    fields: {
      judge: {
        kind: HOST_JUDGE,
        policy,
        onUnsure,
        deadlineMs,
        attempt,
        checks: [],
      },
      rounds: [roundSummary(record, record.request.checks.map((check) => check.id))],
    },
  }, { now });

  await transitionRun(directory, PENDING_JUDGEMENT, {
    reason: {
      code: OUTCOME_REASONS.awaiting,
      message: `round 1 of ${record.maxRounds} issued, expires ${record.expiresAt}`,
    },
    now,
  });

  return { record, file };
}

/**
 * Issue round 2: the escalation round.
 *
 * ADR 0009 §5 — it carries **only the still-unsure checks**, `onUnsure` is
 * forced to `fail`, and the record is marked `escalationTerminal`. There is no
 * round 3, which means a genuinely ambiguous assertion terminates in `fail`
 * rather than in an endless re-ask. That is the correct default and it will
 * occasionally be annoying.
 *
 * The record never contains the earlier verdicts. Telling a judge what it — or
 * anyone else — said last time destroys the independence that makes ADR 0010's
 * disagreement signal worth anything.
 */
export async function issueEscalationRound(directory, {
  run,
  previous,
  checkIds,
  deadlineMs = DEFAULT_DEADLINE_MS,
  pixelproofVersion = null,
  now = new Date(),
}) {
  const wanted = new Set(checkIds);
  const checks = previous.request.checks.filter((check) => wanted.has(check.id));
  const issuedAt = now.toISOString();

  const record = buildPendingRecord({
    runId: run.runId,
    round: previous.round + 1,
    checks,
    artifactPath: previous.artifact.path,
    artifactSha256: previous.artifact.sha256,
    artifactBytes: previous.artifact.bytes,
    context: previous.request.context,
    issuedAt,
    expiresAt: expiryFrom(issuedAt, deadlineMs),
    pixelproofVersion,
    specDigest: previous.specDigest,
    onUnsure: 'fail',
    nonce: newNonce(),
    escalationTerminal: true,
  });

  const file = await writePendingRecord(directory, record);
  return { record, file };
}

/**
 * Apply a validated submission and decide what happens to the run.
 *
 * Everything is written before anything is finalised, and the run is finalised
 * last, so the terminal record is never reached with evidence still missing
 * from the directory it points at.
 *
 * @returns {Promise<{outcome: 'accepted'|'rejected'|'escalated', reason: string|null,
 *   checks: object[], record?: object, run: object}>}
 */
export async function applySubmission(directory, {
  run,
  round,
  record,
  response,
  attempt,
  pixelproofVersion = null,
  now = new Date(),
}) {
  const judge = run.judge ?? {};
  const policy = judge.policy ?? DEFAULT_POLICY;
  const deadlineMs = judge.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const at = now.toISOString();

  await writeResultRecord(directory, buildResultRecord({
    runId: run.runId,
    round: record.round,
    checksDigest: record.checksDigest,
    response,
    submittedAt: at,
  }));

  // An `ok: false` reply finalises the run as rejected, not as a skipped tier
  // (ADR 0009 §5). A judge that errored produced no verdicts, and no verdicts is
  // not a pass.
  if (response.ok === false) {
    const rounds = closeRound(run, record.round, at);
    await recordRunFields(directory, { fields: { rounds } }, { now });
    const { run: finalised } = await finaliseRun(directory, {
      state: REJECTED,
      reason: {
        code: OUTCOME_REASONS.judgeError,
        message: response.error?.message ?? 'the judge reported a failure',
      },
      now,
    });
    return { outcome: 'rejected', reason: OUTCOME_REASONS.judgeError, checks: [], run: finalised };
  }

  const checks = foldVerdicts({ prior: judge.checks ?? [], record, response, policy });
  const decision = decideOutcome({
    checks,
    onUnsure: record.onUnsure ?? judge.onUnsure ?? 'escalate',
    round: record.round,
  });

  await recordAttemptSemantic(directory, attempt, {
    judge: HOST_JUDGE,
    policy,
    round: record.round,
    checks,
  }, { now });

  if (decision.outcome === 'escalate') {
    const escalation = await issueEscalationRound(directory, {
      run,
      previous: record,
      checkIds: decision.checks,
      deadlineMs,
      pixelproofVersion,
      now,
    });

    const rounds = [
      ...closeRound(run, record.round, at),
      roundSummary(escalation.record, decision.checks),
    ];

    await recordRunFields(directory, {
      fields: { judge: { ...judge, checks }, rounds },
    }, { now });

    // The self-edge: round 2 leaves the run pending (state.mjs), recorded so the
    // report shows a second checklist was issued rather than one that lingered.
    const nextRun = await transitionRun(directory, PENDING_JUDGEMENT, {
      reason: {
        code: OUTCOME_REASONS.awaiting,
        message: `escalated to round ${escalation.record.round}: ${decision.checks.length} check(s) still unsure`,
      },
      now,
    });

    return {
      outcome: 'escalated',
      reason: null,
      checks,
      record: escalation.record,
      run: nextRun,
    };
  }

  await recordRunFields(directory, {
    fields: { judge: { ...judge, checks }, rounds: closeRound(run, record.round, at) },
  }, { now });

  const { run: finalised } = await finaliseRun(directory, {
    state: decision.outcome === 'accepted' ? ACCEPTED : REJECTED,
    reason: {
      code: decision.reason,
      message: decision.outcome === 'accepted'
        ? `every semantic assertion passed under the ${policy} policy`
        : `${decision.checks.length} assertion(s) did not pass: ${decision.checks.join(', ')}`,
    },
    acceptedAttempt: decision.outcome === 'accepted' ? attempt : null,
    now,
  });

  return { outcome: decision.outcome, reason: decision.reason, checks, run: finalised };
}

/** Mark a round answered, leaving every other round untouched. */
function closeRound(run, round, at) {
  const rounds = Array.isArray(run.rounds) ? run.rounds : [];
  return rounds.map((entry) => (entry.round === round
    ? { ...entry, submittedAt: at, files: { ...entry.files, result: pendingResultFile(round) } }
    : entry));
}

/**
 * Close a pending run without a verdict.
 *
 * Both callers land here: `judge abandon`, and `judge submit` meeting an expired
 * deadline. Both finalise as **rejected** with reason `judgement-abandoned`
 * (ADR 0009 §4 and its command table). Expiry is a verdict about the *process*,
 * never about the artifact — which is why the rejected candidate stays on disk
 * in the run directory and is named in the report.
 *
 * The `abandoned` state exists in the machine for a run killed some other way;
 * neither of these paths is that, so neither writes it.
 */
export async function closePendingRun(directory, { message, now = new Date() } = {}) {
  const { run, report } = await finaliseRun(directory, {
    state: REJECTED,
    reason: { code: OUTCOME_REASONS.abandoned, message: message ?? null },
    now,
  });
  return { run, report };
}

/**
 * Copy the accepted artifact to where the caller asked for it (ADR 0009 §2).
 *
 * **Promotion happens only on acceptance.** Under `--judge` the generator writes
 * into the run directory, and the file appears at `--out` when the run is
 * accepted; an abandoned run therefore leaves no file where a caller would look
 * for one. This is the mechanical form of "an unanswered checklist is not a
 * pass", and it is the part of ADR 0009 most likely to surprise.
 *
 * Returns `null` when the run named no destination — `verify --judge host` has
 * no `--out` and nothing to promote.
 */
export async function promoteArtifact(directory, { run, attempt }) {
  const destination = run?.resolved?.out ?? null;
  if (typeof destination !== 'string' || destination.trim() === '') return null;

  const entry = (run.attempts ?? []).find((candidate) => candidate.number === attempt);
  if (!entry?.artifact?.path) return null;

  const source = path.resolve(directory, entry.artifact.path);
  const target = path.resolve(destination);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(source, target);
  return target;
}
