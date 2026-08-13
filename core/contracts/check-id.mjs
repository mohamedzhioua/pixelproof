/**
 * Deterministic identities for semantic checks (ADR 0010).
 *
 * IDs are derived from the assertion text rather than its position. Position is
 * stable only until a spec is reordered, and Spec v2's `extends` concatenates
 * arrays — a parent gaining one assertion would renumber every child ID and
 * silently break cross-run comparison of the same check. Content derivation
 * keeps an assertion's identity attached to its meaning.
 */

import { createHash } from 'node:crypto';

const ID_PREFIX = 's-';
const DIGEST_LENGTH = 10;

/**
 * Assertions that differ only in surrounding whitespace are the same assertion.
 * Case is preserved: it can carry meaning in brand and copy requirements.
 */
function canonicalize(assertion) {
  return assertion.trim().replace(/\s+/gu, ' ');
}

export function checkIdFor(assertion) {
  if (typeof assertion !== 'string' || assertion.trim() === '') {
    throw new TypeError('A semantic assertion must be a non-empty string');
  }
  const digest = createHash('sha256').update(canonicalize(assertion), 'utf8').digest('hex');
  return `${ID_PREFIX}${digest.slice(0, DIGEST_LENGTH)}`;
}

/**
 * Assign IDs across a list. A spec may legitimately repeat an assertion (for
 * example after composition); duplicates get an explicit occurrence suffix so
 * every ID in a request is unique, which the judge contract requires in order to
 * pair results back one-to-one.
 */
export function assignCheckIds(assertions) {
  if (!Array.isArray(assertions)) {
    throw new TypeError('assertions must be an array');
  }

  const seen = new Map();
  return assertions.map((assertion) => {
    const baseId = checkIdFor(assertion);
    const occurrence = (seen.get(baseId) ?? 0) + 1;
    seen.set(baseId, occurrence);
    return {
      id: occurrence === 1 ? baseId : `${baseId}#${occurrence}`,
      assertion: canonicalize(assertion),
    };
  });
}

export function isCheckId(value) {
  return typeof value === 'string'
    && new RegExp(`^${ID_PREFIX}[0-9a-f]{${DIGEST_LENGTH}}(#\\d+)?$`, 'u').test(value);
}
