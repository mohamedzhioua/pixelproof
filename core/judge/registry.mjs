/**
 * Judge registry and discovery (ADR 0021 §1, §2, §8).
 *
 * ADR 0009 §5 assumed a registry — `judge: ["gemini", "host"]` — without
 * specifying one. This is it, and it is a *second* registry rather than a
 * widened provider one.
 *
 * The reason is `core/adapters/discover.mjs`'s two demands: a `generate`
 * function, and a manifest validated by `validateManifest()`. A judge has no
 * `generate`, and that validator is a normalizing allowlist over generation
 * geometry which would discard every field a judge actually declares and hand
 * back a fabricated capability record. Reusing it would put a lie in the report
 * `doctor` prints, which is this project's own failure mode aimed at itself.
 *
 * What *is* shared is the part that should be: the indexing, the ordering and
 * the duplicate rule all live in `core/adapters/registry.mjs`, so there is still
 * exactly one place a registry is built. Ids are unique within a role and not
 * across roles — `codex` is a provider and a judge, one vendor in two roles.
 *
 * Discovery never scans the filesystem and never imports `judges/`. A judge
 * becomes visible in exactly one way: the composition layer that already imports
 * it hands it over. ADR 0002's one-way dependency is untouched.
 */

import { AdapterError } from '../contracts/errors.mjs';
import { validateJudgeManifest } from '../contracts/judge.mjs';
import {
  TRUST_BUILTIN,
  TRUST_EXTERNAL,
  buildRegistry,
  invalidRegistration as invalid,
  isPlainObject,
  isTrustClass,
  normalizeDetection,
  probeEntries,
} from '../adapters/registry.mjs';

export { TRUST_BUILTIN, TRUST_EXTERNAL } from '../adapters/registry.mjs';

/**
 * Normalize one judge registration into a frozen entry.
 *
 * The manifest is validated here rather than trusted from the module, for the
 * same reason the provider registry does it: a malformed capability record
 * should fail at registration, the cheapest possible moment, rather than at the
 * first paid call.
 */
export function normalizeJudge(raw, { trust = TRUST_BUILTIN } = {}) {
  if (!isPlainObject(raw)) throw invalid('A judge registration must be an object');
  if (!isTrustClass(trust)) throw invalid(`Unknown trust class "${trust}"`, { trust });

  const manifest = validateJudgeManifest(raw.manifest);

  if (raw.id !== undefined && raw.id !== manifest.id) {
    throw invalid(
      `Judge registration id "${raw.id}" disagrees with its manifest id "${manifest.id}"`,
      { id: raw.id, manifestId: manifest.id },
    );
  }
  if (typeof raw.judge !== 'function') {
    throw invalid(`Judge "${manifest.id}" must expose a judge function`);
  }
  if (raw.detect !== undefined && typeof raw.detect !== 'function') {
    throw invalid(`Judge "${manifest.id}" detect must be a function when present`);
  }

  return Object.freeze({
    id: manifest.id,
    trust,
    manifest,
    kinds: Object.freeze([...manifest.kinds]),
    // Unlike a provider, a judge with no detect is *not* assumed available: every
    // judge this build can have drives an external CLI, so "nothing to install"
    // is not a shape that exists here. Saying available without looking is the
    // claim ADR 0016 exists to forbid.
    detect: raw.detect ?? (() => ({ available: false, reason: `judge "${manifest.id}" declares no detect` })),
    judge: raw.judge,
  });
}

/**
 * Build a judge registry from raw registrations.
 *
 * @param {Array<object>} entries
 */
export function createJudgeRegistry(entries = []) {
  if (!Array.isArray(entries)) throw invalid('createJudgeRegistry requires an array of judges');
  return buildRegistry(entries.map((entry) => normalizeJudge(entry, { trust: TRUST_BUILTIN })), { noun: 'judge' });
}

/**
 * Assemble the judge registry. Built-ins keep registration order.
 *
 * **External judges are refused rather than ignored (ADR 0021 §8).** Accepting
 * them would mean importing or configuring third-party judge modules, and ADR
 * 0004 is explicit that Pixelproof never auto-imports arbitrary project code.
 * The shape is reserved so the day it is built is an addition rather than a
 * redesign; silently dropping a configured judge would instead report an
 * artifact as judged by a panel that never ran.
 *
 * @param {{builtins?: Array<object>, external?: Array<object>}} [sources]
 */
export function discoverJudges({ builtins = [], external = [] } = {}) {
  if (!Array.isArray(builtins) || !Array.isArray(external)) {
    throw invalid('discoverJudges requires arrays of builtin and external judges');
  }
  if (external.length > 0) {
    throw invalid(
      'External judges are not supported by this build: a third-party judge would have to be '
        + 'imported in-process, which ADR 0004 forbids. Only bundled judges may be registered.',
      { external: external.length },
    );
  }

  return createJudgeRegistry(builtins);
}

/**
 * Look up a judge by id, optionally requiring it to support an artifact kind.
 *
 * A missing judge is `PROVIDER_UNAVAILABLE`, not `INVALID_REQUEST`: the request
 * was well formed, the judge simply is not here. That is the same distinction
 * `selectProvider` draws, and the same code `judges/codex.mjs` already throws
 * when the Codex CLI is absent — ADR 0006's enum is closed and this does not
 * extend it.
 */
export function selectJudge(registry, { id, kind = null } = {}) {
  if (typeof id !== 'string' || id === '') throw invalid('selectJudge requires a judge id');

  const entry = registry.get(id);
  if (!entry) {
    throw new AdapterError('PROVIDER_UNAVAILABLE', `No judge is registered under "${id}"`, {
      retryable: false,
      details: { id, registered: registry.ids() },
    });
  }
  if (kind !== null && !entry.kinds.includes(kind)) {
    throw invalid(
      `Judge "${id}" does not judge ${kind} artifacts; it declares ${[...entry.kinds].join(', ')}`,
      { id, kind, kinds: [...entry.kinds] },
    );
  }
  return entry;
}

/**
 * Is one judge usable at all? Cheap, read-only, no network and no paid call.
 *
 * Used at the *front door* (ADR 0021 §3): a judge that is not installed must be
 * refused before a generation is spent, not after. A missing CLI is not a
 * verdict about an artifact, and letting it become one would reject an image
 * nothing ever looked at.
 *
 * A `detect` that throws reports unavailable with its message rather than
 * propagating: the answer to "can this judge run?" is no, and the reason is
 * worth keeping.
 */
export async function detectJudge(entry) {
  try {
    return normalizeDetection(await entry.detect());
  } catch (error) {
    return { available: false, reason: error?.message ?? String(error) };
  }
}

/**
 * Probe every registered judge, for `doctor`.
 *
 * **Availability is not authentication** (ADR 0016). A judge on PATH is
 * available; whether its subscription will answer is `unknown` and stays
 * unknown, because the only ways to find out are a network call or a paid call.
 */
export async function probeJudges(registry) {
  return probeEntries(registry);
}
