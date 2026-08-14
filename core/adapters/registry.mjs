/**
 * The indexing half of a registry, shared by every role (ADR 0005, ADR 0021 §1).
 *
 * `discover.mjs` used to hold this inline, under the comment "the one place a
 * registry is built, so the duplicate rule has a single home". ADR 0021 adds a
 * second role — judges — and copying the rule would have made that sentence
 * false on the day it was copied. So the *indexing* moved here and each role
 * keeps its own **normalizer**, which is the half that actually differs: a
 * provider must expose `generate` and a generation manifest, a judge must expose
 * `judge` and a judge manifest, and no validator is asked to pretend it
 * understands both.
 *
 * The three determinism rules live here with it:
 *
 * 1. Built-ins keep the order they were registered in — a decision the caller
 *    makes once, not an accident of directory listing or hash order.
 * 2. External entries are sorted by id, because configuration may arrive as an
 *    object whose key order is not something a user chose.
 * 3. A duplicate id is a hard error. Last-one-wins would let a third party
 *    silently shadow a built-in, which is a supply-chain problem wearing a
 *    convenience feature's clothes.
 *
 * Ids are unique **within a role and not across roles** (ADR 0021 §1). `codex`
 * is a provider and a judge: one vendor, two roles. A shared namespace would
 * force one of them to be renamed for a collision that is not one, so each role
 * builds its own registry and the duplicate rule bites where shadowing is
 * actually a hazard.
 */

import { AdapterError } from '../contracts/errors.mjs';

/** Bundled, imported in-process, runs with this process's authority. */
export const TRUST_BUILTIN = 'builtin';

/** Third-party, executed out of process through the subprocess transport. */
export const TRUST_EXTERNAL = 'external';

export const TRUST_CLASSES = Object.freeze([TRUST_BUILTIN, TRUST_EXTERNAL]);

const TRUST_SET = new Set(TRUST_CLASSES);

export function isTrustClass(value) {
  return typeof value === 'string' && TRUST_SET.has(value);
}

export function invalidRegistration(message, details) {
  return new AdapterError('INVALID_REQUEST', message, { retryable: false, details: details ?? null });
}

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Sort by id, for the group whose order nobody chose. */
export function byId(left, right) {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/**
 * Index normalized entries, rejecting duplicates and preserving order.
 *
 * @param {Array<{id: string, trust: string}>} normalized
 * @param {{noun?: string}} [options] what a row is called in an error message —
 *   "provider" or "judge". The rule is the same; the sentence a user reads
 *   should name the thing they actually registered.
 */
export function buildRegistry(normalized, { noun = 'provider' } = {}) {
  const byIdMap = new Map();
  const ordered = [];

  for (const entry of normalized) {
    if (byIdMap.has(entry.id)) {
      const first = byIdMap.get(entry.id);
      throw invalidRegistration(
        `Duplicate ${noun} id "${entry.id}": already registered as ${first.trust}, offered again as ${entry.trust}`,
        { id: entry.id, registered: first.trust, offered: entry.trust },
      );
    }
    byIdMap.set(entry.id, entry);
    ordered.push(entry);
  }

  return Object.freeze({
    /** Registration order, always. */
    list: () => [...ordered],
    ids: () => ordered.map((entry) => entry.id),
    has: (id) => byIdMap.has(id),
    get: (id) => byIdMap.get(id) ?? null,
    size: ordered.length,
  });
}

/**
 * Probe every registered entry through its own `detect`.
 *
 * A detect that throws reports unavailable with its message rather than taking
 * the whole probe down: one broken adapter must not hide the healthy ones.
 * Results come back in registry order.
 */
export async function probeEntries(registry) {
  const results = [];

  for (const entry of registry.list()) {
    let detection;
    try {
      detection = normalizeDetection(await entry.detect());
    } catch (error) {
      detection = { available: false, reason: error?.message ?? String(error) };
    }
    results.push({
      id: entry.id,
      trust: entry.trust,
      kinds: [...entry.kinds],
      available: detection.available,
      reason: detection.reason,
    });
  }

  return results;
}

export function normalizeDetection(value) {
  if (value === true) return { available: true, reason: null };
  if (value === false || value === null || value === undefined) {
    return { available: false, reason: null };
  }
  if (!isPlainObject(value)) return { available: Boolean(value), reason: null };
  return {
    available: value.available === true,
    reason: typeof value.reason === 'string' ? value.reason : null,
  };
}
