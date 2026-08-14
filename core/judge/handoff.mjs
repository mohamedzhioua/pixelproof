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
  RUNNING,
  finaliseRun,
  recordAttemptSemantic,
  recordRunFields,
  transitionRun,
} from '../run/index.mjs';
import { DEFAULT_DEADLINE_MS, expiryFrom } from './deadline.mjs';
import { newNonce } from './digest.mjs';
import {
  HOST_JUDGE,
  MAX_ROUNDS,
  buildPendingRecord,
  buildResultRecord,
  pendingRequestFile,
  pendingResultFile,
  writePendingRecord,
  writeResultRecord,
} from './pending.mjs';
import { panelCanEscalate } from './panel.mjs';
import { boundOf, hasRetakeLeft, nextAttemptNumber, retakesLeft } from './retake.mjs';
import {
  OUTCOME_REASONS,
  decideOutcome,
  foldVerdicts,
  roundInAttempt,
} from './submit.mjs';

/** The default consensus policy (ADR 0010). A panel of one still routes through it. */
export const DEFAULT_POLICY = 'all';

/**
 * One row of `run.json`'s `rounds`.
 *
 * `attempt` is recorded on every round (ADR 0020 §5) because round numbers run
 * across the whole run while ADR 0009 §5's bound of two rounds is per attempt.
 * Without it, nothing could tell attempt 2's escalation from a forbidden round 3.
 */
function roundSummary(record, checks) {
  return {
    round: record.round,
    attempt: record.attempt ?? 1,
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
 * Open an attempt's first round: write `judge-request-<round>.json`, record it,
 * and move the run to `pending-judgement`.
 *
 * The order matters. The checklist is on disk *before* the state says a
 * checklist exists, so a process killed between the two leaves a run that is
 * still `running` with a stray request file — recoverable and obviously
 * incomplete — rather than a run that claims to be pending with nothing to
 * answer.
 *
 * On a retake this is called again for attempt *n+1* (ADR 0020 §5): `round`
 * continues from the last one issued rather than restarting, so the request
 * filename stays unique inside the directory, and the per-check verdict table is
 * **reset**. Attempt *n+1* is judged on its own bytes; carrying attempt *n*'s
 * verdicts forward would let a verdict about a file that is no longer the
 * subject decide a run — the exact confusion ADR 0009 §1 exists to prevent.
 * Attempt *n*'s verdicts stay where they were written, in `attempt-<n>.json`.
 *
 * ## `pending: false` — the subprocess round (ADR 0021 §3, §5)
 *
 * A subprocess judge is a call, not a state. Its round leaves exactly the same
 * evidence — the request file is written *before* the judge is spawned, so the
 * question that crossed is on disk whatever the answer turns out to be — but the
 * run stays `running` and never enters `pending-judgement`. Nothing is
 * outstanding, because the answer arrives in this process.
 *
 * The record's `nonce` is written and is **inert** on that path. It proves which
 * pending file a submitter read, and there is no submitter. `judge submit`
 * cannot reach such a round at all: the run is not `pending-judgement`, so the
 * state machine refuses it with `PENDING_NOT_OPEN`. One closed door, enforced by
 * the machine, rather than a second rule about which envelopes may be answered.
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
  round = 1,
  kind = HOST_JUDGE,
  panel = null,
  pending = true,
  now = new Date(),
}) {
  const issuedAt = now.toISOString();
  const record = buildPendingRecord({
    runId: run.runId,
    round,
    attempt,
    roundInAttempt: 1,
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
        kind,
        // Absent on a run opened before ADR 0021, where `kind: "host"` said
        // everything there was to say about who was judging.
        ...(panel === null ? {} : { panel }),
        policy,
        onUnsure,
        deadlineMs,
        attempt,
        checks: [],
      },
      rounds: [
        ...(Array.isArray(run.rounds) ? run.rounds : []),
        roundSummary(record, record.request.checks.map((check) => check.id)),
      ],
    },
  }, { now });

  if (!pending) return { record, file };

  await transitionRun(directory, PENDING_JUDGEMENT, {
    reason: {
      code: OUTCOME_REASONS.awaiting,
      // Attempt 1 keeps the sentence it has always had; only a retake needs to
      // say which attempt a run-wide round number belongs to.
      message: attempt === 1
        ? `round ${record.round} of ${record.maxRounds} issued, expires ${record.expiresAt}`
        : `round ${record.round} (attempt ${attempt}, round 1 of ${record.maxRounds}) issued, expires ${record.expiresAt}`,
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
    // The run-wide counter continues; the attempt-relative one is always 2,
    // because escalation is the second and last round of an attempt.
    round: previous.round + 1,
    attempt: previous.attempt ?? 1,
    roundInAttempt: MAX_ROUNDS,
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
 * ADR 0020 §2 adds a fourth outcome. A semantic rejection with the retake bound
 * unspent does **not** finalise: the verdicts are recorded, the run moves back
 * to `running`, and the ball passes to whoever decides whether to spend another
 * generation. `judge submit` still never generates — that is what keeps
 * `surfaces/cli/commands/judge.mjs` out of the provider tree and stops
 * `--interactive` on a human's terminal from silently starting a paid call.
 *
 * The move to `running` happens **after** every write, in the same order as
 * every other finalisation here, so a process killed mid-way leaves a run still
 * marked `pending-judgement` with its verdicts on disk rather than a run that
 * says it is between attempts with the last one's judgement missing.
 *
 * ## Both judge kinds arrive here (ADR 0021 §4)
 *
 * The host path reaches this after `judge submit`'s identity checks; a
 * subprocess judge reaches it directly, in the same process, with no identity
 * check because there is no second process whose claim needs proving. What
 * happens to a set of verdicts is decided **once**, here. Two implementations
 * that agree today would be free to drift, and the drift would be invisible
 * until an artifact was accepted on one path that the other would have rejected.
 *
 * Two things vary by kind, and both are read from the run record rather than
 * assumed:
 *
 * - **who answered** (`judgeId`), which `attempt-<n>.json` records; and
 * - **whether an `unsure` may escalate**, which is `panelCanEscalate` on the
 *   recorded panel (ADR 0021 §6).
 *
 * @returns {Promise<{outcome: 'accepted'|'rejected'|'escalated'|'retakeable', reason: string|null,
 *   checks: object[], record?: object, run: object, attempt?: number,
 *   noEscalationAuthority?: boolean}>}
 */
export async function applySubmission(directory, {
  run,
  round,
  record,
  response,
  attempt,
  judgeId = HOST_JUDGE,
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
    // Attempt-relative, never run-wide: attempt 2's first round is run round 3
    // and is still entitled to the one escalation ADR 0009 §5 grants an attempt.
    round: record.roundInAttempt ?? roundInAttempt(run, record.round),
    // Read from the recorded panel, so a `judge submit` arriving in a later
    // process reaches the same answer as the process that issued the round.
    canEscalate: panelCanEscalate(judge),
  });

  await recordAttemptSemantic(directory, attempt, {
    judge: judgeId,
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

  const recorded = await recordRunFields(directory, {
    fields: { judge: { ...judge, checks }, rounds: closeRound(run, record.round, at) },
  }, { now });

  // ADR 0020 §2: a rejected attempt with the bound unspent leaves the run open
  // for a new attempt number instead of finalising. `hasRetakeLeft` reads the
  // record just written, so the count includes the attempt that was judged.
  //
  // A judge that *errored* never reaches here — that path finalises above — and
  // deliberately so: `ok: false` says the judging failed, not the artifact, and
  // spending a generation to answer a broken judge would correct the wrong
  // thing.
  if (decision.outcome === 'rejected' && hasRetakeLeft(recorded)) {
    // A subprocess run is **already** `running`: it never paused, because its
    // verdict arrived in this process (ADR 0021 §3). There is nothing to
    // un-pause, `running -> running` is not an edge the machine has, and
    // recording `retake-available` would be false twice over — the run is not
    // waiting for an operator, and `listStalledRuns` counts exactly that reason,
    // so `doctor` would report an orphan during ordinary operation.
    const paused = recorded.state === PENDING_JUDGEMENT;
    const nextRun = paused
      ? await transitionRun(directory, RUNNING, {
        reason: {
          code: OUTCOME_REASONS.retakeAvailable,
          message: `attempt ${attempt} rejected (${decision.reason}); `
            + `${retakesLeftMessage(recorded)} — pixelproof retake --run ${run.runId}`,
        },
        now,
      })
      : recorded;

    return {
      outcome: 'retakeable',
      reason: decision.reason,
      checks,
      run: nextRun,
      attempt: nextAttemptNumber(nextRun),
      noEscalationAuthority: decision.noEscalationAuthority === true,
    };
  }

  // `retakes-exhausted` is recorded only when retakes were actually asked for
  // (ADR 0020 §2). A run left on the default bound of one never requested a
  // second attempt, so calling its rejection "exhausted" would rename the
  // outcome of every judged run that exists today to describe a feature it did
  // not use.
  const exhausted = decision.outcome === 'rejected' && boundOf(recorded) > 1;
  const reasonCode = exhausted ? OUTCOME_REASONS.exhausted : decision.reason;

  const { run: finalised } = await finaliseRun(directory, {
    state: decision.outcome === 'accepted' ? ACCEPTED : REJECTED,
    reason: {
      code: reasonCode,
      message: decision.outcome === 'accepted'
        ? `every semantic assertion passed under the ${policy} policy`
        : `${decision.checks.length} assertion(s) did not pass: ${decision.checks.join(', ')}`
          + (decision.noEscalationAuthority === true
            // Named on the record, not only printed: an operator reading the
            // report months later has to be able to see that the run died for
            // want of an escalation authority rather than on the artifact.
            ? '; unsure, and no escalation authority is configured for this panel (ADR 0021 §6)'
            : '')
          + (exhausted
            ? `; the retake bound of ${boundOf(recorded)} is spent and nothing is promoted on exhaustion`
            : ''),
    },
    acceptedAttempt: decision.outcome === 'accepted' ? attempt : null,
    now,
  });

  return {
    outcome: decision.outcome,
    reason: reasonCode,
    checks,
    run: finalised,
    noEscalationAuthority: decision.noEscalationAuthority === true,
  };
}

/** "2 attempts left" / "1 attempt left" — the tail of the retake message. */
function retakesLeftMessage(run) {
  const left = retakesLeft(run);
  return `${left} attempt${left === 1 ? '' : 's'} left of ${boundOf(run)}`;
}

/** Mark a round answered, leaving every other round untouched. */
function closeRound(run, round, at) {
  const rounds = Array.isArray(run.rounds) ? run.rounds : [];
  return rounds.map((entry) => (entry.round === round
    ? { ...entry, submittedAt: at, files: { ...entry.files, result: pendingResultFile(round) } }
    : entry));
}

/**
 * Close an open run without a verdict.
 *
 * Both callers land here: `judge abandon`, and `judge submit` meeting an expired
 * deadline. Both finalise as **rejected** with reason `judgement-abandoned`
 * (ADR 0009 §4 and its command table). Expiry is a verdict about the *process*,
 * never about the artifact — which is why the rejected candidate stays on disk
 * in the run directory and is named in the report.
 *
 * ADR 0020 lets `judge abandon` reach a run in `running` as well as one in
 * `pending-judgement`, so a run left between attempts can still be closed on the
 * record. Nothing is discarded by doing so: verdicts are written to
 * `attempt-<n>.json`, to `judge-result-<round>.json` and to `run.json`'s check
 * table *before* the run is ever moved off `pending-judgement`, so a run that
 * can be abandoned mid-retake has already recorded everything anyone submitted.
 * The report written here lists every attempt, so the evidence is legible after
 * the close rather than only before it.
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
