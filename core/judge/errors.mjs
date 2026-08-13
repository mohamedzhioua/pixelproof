/**
 * Run-rejection reasons for the host handoff (ADR 0009 §3).
 *
 * These are deliberately a third vocabulary, and the reason is stated in ADR
 * 0014 §6: `AdapterError` codes describe what a separate, possibly untrusted
 * *process* reported; `RunError` codes describe what the run store found in a
 * file this tool wrote; and these describe why a *submission* was refused. No
 * adapter is involved in a host handoff at all — the host is a caller, not an
 * adapter (ADR 0004) — so borrowing either of the other two enums would say
 * something false about where the failure came from.
 *
 * The set is closed at nine. ADR 0009 §3 enumerates exactly these, and a tenth
 * added here without an ADR would be a refusal nobody decided on.
 *
 * Several of them are this layer's name for a mechanism the store already has —
 * `PENDING_ID_MALFORMED` is `RUN_ID_MALFORMED` seen from the handoff, and
 * `PENDING_NOT_OPEN` is what a terminal-state refusal looks like from here. Two
 * vocabularies, one mechanism (ADR 0014 §6), which is why the mapping below is
 * explicit rather than a string prefix swap.
 */

import { RunError } from '../run/errors.mjs';

/** @type {readonly string[]} */
export const PENDING_REASONS = Object.freeze([
  'PENDING_ID_MALFORMED',
  'PENDING_FOREIGN_ROOT',
  'PENDING_NOT_FOUND',
  'PENDING_NOT_OPEN',
  'PENDING_SCHEMA_UNSUPPORTED',
  'PENDING_NONCE_MISMATCH',
  'PENDING_CHECKS_MISMATCH',
  'PENDING_EXPIRED',
  'ARTIFACT_CHANGED',
]);

const REASON_SET = new Set(PENDING_REASONS);

export function isPendingReason(code) {
  return REASON_SET.has(code);
}

export class PendingError extends Error {
  constructor(code, message, { details, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'PendingError';
    // Every raise site is inside `core/judge/`, so an unrecognised code is a bug
    // here rather than a reason to widen the set a caller has to handle.
    if (!isPendingReason(code)) {
      throw new TypeError(`PendingError code must be one of ${PENDING_REASONS.join(', ')}`);
    }
    this.code = code;
    this.details = details ?? null;
  }
}

/**
 * The ADR 0014 §6 mapping, written down once.
 *
 * `RUN_CLOSED` and `RUN_STATE_TRANSITION_REFUSED` both land on
 * `PENDING_NOT_OPEN` because from the submitter's side they are the same fact:
 * there is no open round to answer. That is what makes the nonce single-use — a
 * replay finds a run that has already left `pending-judgement`.
 */
const FROM_RUN_ERROR = Object.freeze({
  RUN_ID_MALFORMED: 'PENDING_ID_MALFORMED',
  RUN_FOREIGN_ROOT: 'PENDING_FOREIGN_ROOT',
  RUN_NOT_FOUND: 'PENDING_NOT_FOUND',
  RUN_SCHEMA_UNSUPPORTED: 'PENDING_SCHEMA_UNSUPPORTED',
  RUN_STATE_TRANSITION_REFUSED: 'PENDING_NOT_OPEN',
  RUN_CLOSED: 'PENDING_NOT_OPEN',
});

/**
 * Re-express a store failure in the handoff's vocabulary, preserving the
 * original as `cause` so nothing is lost. Anything that is not a `RunError` is
 * rethrown untouched: an `EACCES` is not a refused submission, and dressing it
 * up as one would hide a broken disk behind a protocol message.
 */
export function asPendingError(error, { details = null } = {}) {
  if (!(error instanceof RunError)) throw error;
  const code = FROM_RUN_ERROR[error.code];
  if (code === undefined) throw error;
  return new PendingError(code, error.message, {
    details: { ...(error.details ?? {}), ...(details ?? {}) },
    cause: error,
  });
}
