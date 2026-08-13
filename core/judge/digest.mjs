/**
 * The two digests and the one secret the handoff runs on (ADR 0009 §2, §3).
 *
 * The distinction this module exists to keep straight:
 *
 * - `checksDigest` and the artifact's `sha256` prove the **subject** is
 *   unchanged — the same assertions about the same bytes.
 * - the `nonce` proves **whose pending run this is**.
 *
 * They are not interchangeable, and ADR 0009 §3 is emphatic about why: two
 * concurrent runs of the same spec over the same image compute identical
 * digests, so no amount of content hashing can tell them apart. That is ADR
 * 0008's single-foreign-candidate hole exactly, and the answer is the same —
 * positive identity, not a stricter reading of the same evidence.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';

/** 32 random bytes, as ADR 0009 §3 requires, rendered as 64 hex characters. */
const NONCE_BYTES = 32;

export const NONCE_PATTERN = /^[0-9a-f]{64}$/;
export const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export function newNonce() {
  return randomBytes(NONCE_BYTES).toString('hex');
}

export function isNonce(value) {
  return typeof value === 'string' && NONCE_PATTERN.test(value);
}

/**
 * Compare two nonces without leaking their difference through timing.
 *
 * The nonce is the one secret in this design, and a length-varying or
 * early-exit comparison is the classic way to hand it back one byte at a time.
 * The shape check happens first so `timingSafeEqual` is never handed buffers of
 * different lengths, which throws rather than returning false.
 */
export function nonceMatches(left, right) {
  if (!isNonce(left) || !isNonce(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

/**
 * Deterministic JSON: object keys sorted, no incidental whitespace.
 *
 * "Canonical" in ADR 0009 §2 has to mean something a second implementation can
 * reproduce, so key order cannot be whatever the producer's object literal
 * happened to be. Arrays keep their order — an array's order is data.
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;

  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  const fields = keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
  return `{${fields.join(',')}}`;
}

export function sha256OfString(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * The digest that says "these are the same assertions".
 *
 * ADR 0009 §2: the SHA-256 of the canonical JSON of the `[id, assertion]`
 * pairs, sorted by id. Sorting by id rather than by position is what makes a
 * reordered spec produce the same digest — reordering does not change what was
 * asked, and ADR 0010 already detached check identity from position.
 */
export function checksDigestFor(checks) {
  if (!Array.isArray(checks) || checks.length === 0) {
    throw new TypeError('checksDigestFor requires at least one check');
  }
  const pairs = checks
    .map((check) => {
      if (typeof check?.id !== 'string' || typeof check?.assertion !== 'string') {
        throw new TypeError('every check must carry a string id and assertion');
      }
      return [check.id, check.assertion];
    })
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));

  return sha256OfString(canonicalJson(pairs));
}

/** The digest that says "this is the same spec". Absent spec digests to null. */
export function specDigestFor(spec) {
  if (spec === null || spec === undefined) return null;
  return sha256OfString(canonicalJson(spec));
}

/** Streamed so a large artifact is not held in memory to be hashed. */
export async function sha256OfFile(file) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}
