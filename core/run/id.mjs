/**
 * Run identity (ADR 0009 §2, ADR 0014 §2).
 *
 * `YYYY-MM-DDTHH-MM-SSZ-<8 hex>`. The time separator is a hyphen, not the colon
 * ISO-8601 uses, because a colon is not a legal Windows filename character and
 * the id *is* the directory name. That is the whole reason the format is
 * spelled out in an ADR rather than left to `toISOString()`.
 *
 * The timestamp makes ids sort chronologically as plain strings — which is why
 * enumeration needs no index file — and the 8 random hex characters make two
 * runs started in the same second distinguishable. The random half is not
 * security: identity for the handoff is proven by ADR 0009's nonce, not by the
 * id. This only has to avoid collisions.
 */

import { randomBytes } from 'node:crypto';

import { RunError } from './errors.mjs';

/** The one place the format is written down. */
export const RUN_ID_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z-[0-9a-f]{8}$/;

/** Number of hex characters in the random suffix. */
const SUFFIX_HEX = 8;

export function isRunId(value) {
  return typeof value === 'string' && RUN_ID_PATTERN.test(value);
}

/**
 * Format the timestamp half. Derived from `toISOString()` rather than from
 * hand-assembled date parts so month/day padding and the UTC conversion come
 * from the platform, then the two colons are replaced.
 *
 * @param {Date} date
 */
export function runIdTimestamp(date = new Date()) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new TypeError('runIdTimestamp requires a valid Date');
  }
  // 2026-08-13T09:21:04.512Z -> 2026-08-13T09-21-04Z
  return `${date.toISOString().slice(0, 19).replace(/:/g, '-')}Z`;
}

/**
 * Mint a run id.
 *
 * @param {{now?: Date, suffix?: string}} [options] `suffix` exists for tests
 *   that need a fixed id; it is validated, not trusted.
 */
export function newRunId({ now = new Date(), suffix } = {}) {
  const random = suffix === undefined
    ? randomBytes(Math.ceil(SUFFIX_HEX / 2)).toString('hex').slice(0, SUFFIX_HEX)
    : suffix;

  if (!/^[0-9a-f]{8}$/.test(random)) {
    throw new TypeError('newRunId suffix must be 8 lowercase hex characters');
  }

  const id = `${runIdTimestamp(now)}-${random}`;
  // Belt and braces: the format is asserted here so a change to the assembly
  // above cannot silently produce ids the reader will later refuse.
  if (!isRunId(id)) throw new TypeError(`assembled run id is malformed: ${id}`);
  return id;
}

/**
 * Gate for any id that came from outside — a `--run` flag, a directory name on
 * disk. ADR 0009 §3 requires the regex check *before* a path is built from the
 * value, so `--run ../../etc` is refused rather than followed.
 */
export function assertRunId(value) {
  if (!isRunId(value)) {
    throw new RunError('RUN_ID_MALFORMED', `Run id is not well-formed: ${JSON.stringify(value ?? null)}`, {
      details: { runId: value ?? null, pattern: RUN_ID_PATTERN.source },
    });
  }
  return value;
}
