/**
 * Run state machine (ADR 0009 §2, ADR 0014 §2).
 *
 * The state set is closed within `pixelproof.run/1`: adding a member costs a
 * major, because a consumer that switches exhaustively on `state` is doing the
 * right thing and must not be broken for it.
 *
 * Two properties are load-bearing and are enforced here rather than left to the
 * caller's discipline:
 *
 * 1. **Terminal is terminal.** `accepted`, `rejected` and `abandoned` have no
 *    outgoing edges at all. This is what makes ADR 0009's nonce single-use: a
 *    replayed submission finds a run that cannot leave its final state, so it is
 *    refused by the machine rather than by a check someone might forget.
 * 2. **`pending-judgement` is the only state that returns to `running`, and only
 *    for a new attempt number** (ADR 0020 §1).
 *
 *    This edge was absent, and the reason it was absent is worth keeping rather
 *    than deleting: ADR 0009 §1 forbids regeneration-on-resume, because
 *    re-running *the same* attempt "would produce a different artifact than the
 *    one the host actually looked at, leaving verdicts that describe bytes which
 *    no longer exist". That reason still holds and is still enforced —
 *    everywhere except the one case that does not raise it. Attempt *n*'s bytes,
 *    its mechanical table, its verdicts and its round files are immutable once
 *    written; a retake occupies attempt *n+1*, a new numbered slot, and touches
 *    none of them, so every verdict still describes exactly the bytes it was
 *    formed against.
 *
 *    A state machine cannot express "only for a new attempt number", any more
 *    than it can count rounds. The guard lives in `core/judge/retake.mjs` and in
 *    the submit-side finalisation logic, which take this edge only while the
 *    retake bound is unspent. What the machine still guarantees is the part that
 *    matters most: `accepted -> running` is refused, so no closed run is ever
 *    reopened and the nonce stays single-use.
 *
 * `accepted` is not stored as an independent field anywhere; it is projected
 * from the state by `acceptedFor()`, so there is no second thing that can
 * disagree with the first (ADR 0014 §2).
 */

import { RunError } from './errors.mjs';

export const RUNNING = 'running';
export const PENDING_JUDGEMENT = 'pending-judgement';
export const ACCEPTED = 'accepted';
export const REJECTED = 'rejected';
export const ABANDONED = 'abandoned';

/** @type {readonly string[]} */
export const RUN_STATES = Object.freeze([RUNNING, PENDING_JUDGEMENT, ACCEPTED, REJECTED, ABANDONED]);

/** The states a run can never leave. */
export const TERMINAL_STATES = Object.freeze([ACCEPTED, REJECTED, ABANDONED]);

/** The one state a run may be created in. */
export const INITIAL_STATE = RUNNING;

const STATE_SET = new Set(RUN_STATES);
const TERMINAL_SET = new Set(TERMINAL_STATES);

/**
 * The complete transition table. Every state appears as a key, including the
 * terminal ones with an empty list, so "is this pair legal?" is always answered
 * by a lookup and never by an absent entry.
 */
const TRANSITIONS = Object.freeze({
  // A run in flight may pause for a host judgement or finish in any terminal way.
  [RUNNING]: Object.freeze([PENDING_JUDGEMENT, ACCEPTED, REJECTED, ABANDONED]),
  // The self-edge is ADR 0009 §5's escalation: round 2 leaves the run pending.
  // Bounding rounds at 2 is the round counter's job, not the machine's — a state
  // machine cannot count.
  //
  // `-> RUNNING` is ADR 0020 §1's retake: a rejected attempt with the bound
  // unspent leaves the run open for a *new* attempt number. See the header for
  // why re-opening this particular edge does not raise the hazard ADR 0009 §1
  // closed it against, and where the "new attempt number" half of the rule is
  // enforced.
  [PENDING_JUDGEMENT]: Object.freeze([RUNNING, PENDING_JUDGEMENT, ACCEPTED, REJECTED, ABANDONED]),
  [ACCEPTED]: Object.freeze([]),
  [REJECTED]: Object.freeze([]),
  [ABANDONED]: Object.freeze([]),
});

export function isRunState(value) {
  return typeof value === 'string' && STATE_SET.has(value);
}

export function isTerminalState(value) {
  return typeof value === 'string' && TERMINAL_SET.has(value);
}

/** The states reachable from `state`, as an array. Unknown states reach nothing. */
export function allowedTransitions(state) {
  return TRANSITIONS[state] ?? Object.freeze([]);
}

export function canTransition(from, to) {
  if (!isRunState(from) || !isRunState(to)) return false;
  return allowedTransitions(from).includes(to);
}

/**
 * Refuse an illegal transition with a named reason. Callers get the legal set in
 * `details` so an error message can say what *was* possible.
 */
export function assertTransition(from, to) {
  if (!isRunState(from)) {
    throw new RunError('RUN_STATE_TRANSITION_REFUSED', `Unknown current run state: ${JSON.stringify(from ?? null)}`, {
      details: { from: from ?? null, to: to ?? null, states: [...RUN_STATES] },
    });
  }
  if (!isRunState(to)) {
    throw new RunError('RUN_STATE_TRANSITION_REFUSED', `Unknown target run state: ${JSON.stringify(to ?? null)}`, {
      details: { from, to: to ?? null, states: [...RUN_STATES] },
    });
  }
  if (!canTransition(from, to)) {
    const because = isTerminalState(from)
      ? `${from} is final; a closed run is never reopened`
      : `allowed from ${from}: ${allowedTransitions(from).join(', ') || 'none'}`;
    throw new RunError('RUN_STATE_TRANSITION_REFUSED', `Refusing run transition ${from} -> ${to}: ${because}`, {
      details: { from, to, allowed: [...allowedTransitions(from)] },
    });
  }
  return to;
}

/**
 * `accepted` as a projection of `state` (ADR 0014 §2). `null` while the outcome
 * is genuinely unknown, `false` the moment the run is pending — ADR 0009 §4
 * requires the pending record to say `accepted: false` out loud — and `true`
 * only in the one state that means it.
 */
export function acceptedFor(state) {
  if (!isRunState(state)) {
    throw new RunError('RUN_STATE_TRANSITION_REFUSED', `Unknown run state: ${JSON.stringify(state ?? null)}`, {
      details: { state: state ?? null, states: [...RUN_STATES] },
    });
  }
  if (state === ACCEPTED) return true;
  if (state === RUNNING) return null;
  return false;
}

/**
 * Whether new evidence may still be written into the run. A terminal run's
 * directory is a record; appending to it after the fact would make the report
 * describe something other than what happened.
 */
export function assertOpen(state, action) {
  if (isTerminalState(state)) {
    throw new RunError('RUN_CLOSED', `Cannot ${action}: run is ${state} and closed to further writes`, {
      details: { state, action },
    });
  }
  if (!isRunState(state)) {
    throw new RunError('RUN_STATE_TRANSITION_REFUSED', `Unknown run state: ${JSON.stringify(state ?? null)}`, {
      details: { state: state ?? null, states: [...RUN_STATES] },
    });
  }
  return state;
}
