/**
 * Closed error taxonomy shared by the provider and judge contracts (ADR 0006).
 *
 * Adapters are only permitted to report one of these codes. Anything else is a
 * protocol violation, which is itself reported as INTERNAL by the caller rather
 * than being passed through — an unrecognised code must never widen the set a
 * consumer has to handle.
 */

/** @type {readonly string[]} */
export const ADAPTER_ERROR_CODES = Object.freeze([
  'PROVIDER_UNAVAILABLE',
  'AUTH_REQUIRED',
  'INVALID_REQUEST',
  'TIMEOUT',
  'RATE_LIMITED',
  'CONTENT_REFUSED',
  'INTERNAL',
]);

const ERROR_CODE_SET = new Set(ADAPTER_ERROR_CODES);

/**
 * Process exit codes. Distinct codes let a shell or CI job branch on the class
 * of failure without parsing prose. 0 and 1 keep their v1 meanings (success and
 * verification failure) and are therefore not reused here.
 */
const EXIT_CODES = Object.freeze({
  PROVIDER_UNAVAILABLE: 3,
  AUTH_REQUIRED: 4,
  INVALID_REQUEST: 5,
  TIMEOUT: 6,
  RATE_LIMITED: 7,
  CONTENT_REFUSED: 8,
  INTERNAL: 9,
});

export function isAdapterErrorCode(code) {
  return ERROR_CODE_SET.has(code);
}

export function exitCodeForError(code) {
  return EXIT_CODES[code] ?? EXIT_CODES.INTERNAL;
}

/**
 * Whether a failure is worth another attempt. Retryability is a property of the
 * code, not of the adapter's opinion: an adapter claiming a missing binary is
 * retryable would spin the retake loop for nothing.
 */
export function isRetryableByDefault(code) {
  return code === 'TIMEOUT' || code === 'RATE_LIMITED' || code === 'INTERNAL';
}

export class AdapterError extends Error {
  constructor(code, message, { retryable, details, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'AdapterError';
    this.code = isAdapterErrorCode(code) ? code : 'INTERNAL';
    this.retryable = typeof retryable === 'boolean' ? retryable : isRetryableByDefault(this.code);
    this.details = details ?? null;
  }

  toPayload() {
    return {
      protocol: 1,
      ok: false,
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
      },
    };
  }
}

/**
 * Coerce anything an adapter reported into the closed set. An unknown or absent
 * code becomes INTERNAL and the original value is preserved in `details` so the
 * information is not lost while the public surface stays closed.
 */
export function normalizeErrorPayload(error, { fallbackMessage = 'Adapter failed' } = {}) {
  if (error === null || typeof error !== 'object') {
    return { code: 'INTERNAL', message: fallbackMessage, retryable: false, details: null };
  }

  const rawCode = error.code;
  const known = isAdapterErrorCode(rawCode);
  const message = typeof error.message === 'string' && error.message.trim() !== ''
    ? error.message
    : fallbackMessage;

  return {
    code: known ? rawCode : 'INTERNAL',
    message,
    retryable: typeof error.retryable === 'boolean'
      ? error.retryable
      : isRetryableByDefault(known ? rawCode : 'INTERNAL'),
    details: known ? null : { reportedCode: rawCode ?? null },
  };
}
