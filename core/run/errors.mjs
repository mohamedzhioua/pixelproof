/**
 * Run-store failures (ADR 0014 §6).
 *
 * These are deliberately *not* `AdapterError` codes. ADR 0006's enum describes
 * what an adapter — a separate, possibly untrusted process — reported, and ADR
 * 0009 §3 says the run-rejection reasons "do not extend ADR 0006's closed
 * adapter enum". No adapter is involved in reading a file this tool wrote, so
 * reusing that vocabulary would say something false about where the failure came
 * from.
 *
 * ADR 0009's `PENDING_*` reasons sit one layer above these: `judge submit` names
 * the same mechanism in the vocabulary of the handoff. The mapping is in ADR
 * 0014 §6.
 */

/** @type {readonly string[]} */
export const RUN_ERROR_CODES = Object.freeze([
  'RUN_ID_MALFORMED',
  'RUN_FOREIGN_ROOT',
  'RUN_NOT_FOUND',
  'RUN_SCHEMA_UNSUPPORTED',
  'RUN_STATE_TRANSITION_REFUSED',
  'RUN_CLOSED',
]);

const CODE_SET = new Set(RUN_ERROR_CODES);

export function isRunErrorCode(code) {
  return CODE_SET.has(code);
}

export class RunError extends Error {
  constructor(code, message, { details, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'RunError';
    // The set is closed and every raise site is inside this module, so an
    // unrecognised code is a bug here — not a reason to widen the vocabulary a
    // consumer has to handle.
    if (!isRunErrorCode(code)) {
      throw new TypeError(`RunError code must be one of ${RUN_ERROR_CODES.join(', ')}`);
    }
    this.code = code;
    this.details = details ?? null;
  }
}
