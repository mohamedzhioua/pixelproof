/**
 * `--judge-deadline` parsing (ADR 0009 §4).
 *
 * A unit is **required**. A bare `3600` is refused rather than assumed, because
 * the two plausible readings — seconds and milliseconds — differ by a factor of
 * a thousand, and this tool already carries `PIXELPROOF_TIMEOUT_MS` in
 * milliseconds. Guessing wrong turns a one-hour deadline into a four-second one
 * and expires a run nobody had a chance to answer. Refusing costs one error
 * message; guessing costs a wrongly rejected artifact.
 *
 * The ceiling exists for the same reason the floor does: `9999999999d` is not a
 * deadline, it is an arithmetic overflow that produces an `Invalid Date` in
 * `expiresAt` and a pending record no reader can interpret.
 */

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const UNITS = Object.freeze({
  s: SECOND_MS,
  m: MINUTE_MS,
  h: HOUR_MS,
  d: DAY_MS,
});

/** ADR 0009 §4: 24 hours unless `--judge-deadline` says otherwise. */
export const DEFAULT_DEADLINE_MS = 24 * HOUR_MS;

/** A year. Past this the value is a mistake, not a policy. */
export const MAX_DEADLINE_MS = 365 * DAY_MS;

export const DEADLINE_PATTERN = /^(\d+)([smhd])$/;

/** `24h` -> 86_400_000. Throws with the accepted forms named. */
export function parseDeadline(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('--judge-deadline requires a duration such as 24h, 90m, 45s or 7d');
  }

  const match = DEADLINE_PATTERN.exec(value.trim());
  if (!match) {
    throw new Error(
      `--judge-deadline must be a whole number followed by s, m, h or d (got "${value}"); `
        + 'a bare number is refused because seconds and milliseconds are a thousandfold apart',
    );
  }

  const amount = Number(match[1]);
  const milliseconds = amount * UNITS[match[2]];
  if (milliseconds <= 0) {
    throw new Error(`--judge-deadline must be greater than zero (got "${value}")`);
  }
  if (milliseconds > MAX_DEADLINE_MS) {
    throw new Error(`--judge-deadline must be at most 365d (got "${value}")`);
  }

  return milliseconds;
}

/** The ISO expiry for a record issued at `issuedAt`. */
export function expiryFrom(issuedAt, milliseconds = DEFAULT_DEADLINE_MS) {
  const issued = issuedAt instanceof Date ? issuedAt : new Date(issuedAt);
  if (Number.isNaN(issued.getTime())) {
    throw new TypeError('expiryFrom requires a valid issue timestamp');
  }
  return new Date(issued.getTime() + milliseconds).toISOString();
}

/** Whether a pending record has passed its deadline at `now`. */
export function hasExpired(expiresAt, now = new Date()) {
  const deadline = new Date(expiresAt);
  if (Number.isNaN(deadline.getTime())) return false;
  const at = now instanceof Date ? now : new Date(now);
  return at.getTime() > deadline.getTime();
}

/** `23h 59m` — for the human listing, never parsed by anything. */
export function describeRemaining(expiresAt, now = new Date()) {
  const deadline = new Date(expiresAt);
  if (Number.isNaN(deadline.getTime())) return 'unknown';

  const at = now instanceof Date ? now : new Date(now);
  const remaining = deadline.getTime() - at.getTime();
  if (remaining <= 0) return 'expired';

  const days = Math.floor(remaining / DAY_MS);
  const hours = Math.floor((remaining % DAY_MS) / HOUR_MS);
  const minutes = Math.floor((remaining % HOUR_MS) / MINUTE_MS);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${Math.max(1, minutes)}m`;
}
