/**
 * Provider registry and discovery (ADR 0004, ADR 0005).
 *
 * Discovery never scans the filesystem for modules and never imports project
 * code. A provider becomes visible in exactly one way: someone hands it to this
 * module. Built-ins are handed over by the composition layer that already
 * imports them; third-party adapters are handed over as configuration naming an
 * executable. That is what keeps `core/` free of any import into `providers/`,
 * and it is why adding a provider needs no edit here — the fixture provider
 * under `test/fixtures/providers/` is registered by a test with the same call
 * the real built-ins use.
 *
 * Three rules make the result deterministic:
 *
 * 1. Built-ins keep the order they were registered in. That order is a decision
 *    the caller makes once, not an accident of directory listing or hash order.
 * 2. External adapters are sorted by id, because configuration may arrive as an
 *    object whose key order is not something a user chose.
 * 3. A duplicate id is a hard error. Last-one-wins would let a third-party
 *    adapter silently shadow a built-in, which is a supply-chain problem wearing
 *    a convenience feature's clothes.
 */

import { AdapterError } from '../contracts/errors.mjs';
import { validateManifest } from '../contracts/provider.mjs';

/** Bundled, imported in-process, runs with this process's authority. */
export const TRUST_BUILTIN = 'builtin';

/** Third-party, executed out of process through the subprocess transport. */
export const TRUST_EXTERNAL = 'external';

const TRUST_CLASSES = new Set([TRUST_BUILTIN, TRUST_EXTERNAL]);

function invalid(message, details) {
  return new AdapterError('INVALID_REQUEST', message, { retryable: false, details: details ?? null });
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Normalize one registration into a frozen entry.
 *
 * The manifest is validated as data here rather than trusted from the module,
 * so a built-in with a malformed capability record fails at registration — the
 * cheapest possible moment — instead of at the first paid call.
 */
export function normalizeEntry(raw, { trust = TRUST_BUILTIN } = {}) {
  if (!isPlainObject(raw)) throw invalid('A provider registration must be an object');
  if (!TRUST_CLASSES.has(trust)) {
    throw invalid(`Unknown trust class "${trust}"`, { trust });
  }

  const manifest = validateManifest(raw.manifest);

  if (raw.id !== undefined && raw.id !== manifest.id) {
    throw invalid(
      `Provider registration id "${raw.id}" disagrees with its manifest id "${manifest.id}"`,
      { id: raw.id, manifestId: manifest.id },
    );
  }
  if (typeof raw.generate !== 'function') {
    throw invalid(`Provider "${manifest.id}" must expose a generate function`);
  }
  if (raw.detect !== undefined && typeof raw.detect !== 'function') {
    throw invalid(`Provider "${manifest.id}" detect must be a function when present`);
  }

  return Object.freeze({
    id: manifest.id,
    trust,
    manifest,
    kinds: Object.freeze([...manifest.kinds]),
    // No detect means "always available": a provider that needs nothing installed
    // should not have to say so.
    detect: raw.detect ?? (() => true),
    generate: raw.generate,
  });
}

/**
 * Index normalized entries, rejecting duplicates and preserving order. The one
 * place a registry is built, so the duplicate rule has a single home.
 */
function buildRegistry(normalized) {
  const byId = new Map();
  const ordered = [];

  for (const entry of normalized) {
    if (byId.has(entry.id)) {
      const first = byId.get(entry.id);
      throw invalid(
        `Duplicate provider id "${entry.id}": already registered as ${first.trust}, offered again as ${entry.trust}`,
        { id: entry.id, registered: first.trust, offered: entry.trust },
      );
    }
    byId.set(entry.id, entry);
    ordered.push(entry);
  }

  return Object.freeze({
    /** Registration order, always. */
    list: () => [...ordered],
    ids: () => ordered.map((entry) => entry.id),
    has: (id) => byId.has(id),
    get: (id) => byId.get(id) ?? null,
    size: ordered.length,
  });
}

/**
 * Build a registry from raw registrations, all of one trust class.
 *
 * @param {Array<object>} entries
 * @param {{trust?: string}} [options]
 */
export function createRegistry(entries = [], { trust = TRUST_BUILTIN } = {}) {
  if (!Array.isArray(entries)) throw invalid('createRegistry requires an array of providers');
  return buildRegistry(entries.map((entry) => normalizeEntry(entry, { trust })));
}

/**
 * Assemble the full registry: built-ins in the order given, then external
 * adapters by id. Both groups share one id namespace, so an external adapter
 * cannot take a built-in's name.
 *
 * @param {{builtins?: Array<object>, external?: Array<object>}} [sources]
 */
export function discoverProviders({ builtins = [], external = [] } = {}) {
  if (!Array.isArray(builtins) || !Array.isArray(external)) {
    throw invalid('discoverProviders requires arrays of builtin and external providers');
  }

  const bundled = builtins.map((entry) => normalizeEntry(entry, { trust: TRUST_BUILTIN }));
  const configured = external
    .map((entry) => normalizeEntry(entry, { trust: TRUST_EXTERNAL }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

  return buildRegistry([...bundled, ...configured]);
}

/**
 * Look up a provider by id, optionally requiring it to support a kind.
 *
 * A missing provider is PROVIDER_UNAVAILABLE rather than INVALID_REQUEST: the
 * request was well formed, the provider simply is not here.
 */
export function selectProvider(registry, { id, kind = null } = {}) {
  if (typeof id !== 'string' || id === '') throw invalid('selectProvider requires a provider id');

  const entry = registry.get(id);
  if (!entry) {
    throw new AdapterError('PROVIDER_UNAVAILABLE', `No provider is registered under "${id}"`, {
      retryable: false,
      details: { id, registered: registry.ids() },
    });
  }
  if (kind !== null && !entry.kinds.includes(kind)) {
    throw invalid(`Provider "${id}" does not support kind "${kind}"`, { id, kind, kinds: [...entry.kinds] });
  }
  return entry;
}

function normalizeDetection(value) {
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

/**
 * Probe every registered provider. Used by reporting surfaces (`doctor`) that
 * must distinguish available from unavailable without spending a paid call.
 *
 * A detect that throws reports unavailable with its message rather than taking
 * the whole probe down: one broken adapter must not hide the healthy ones.
 * Results come back in registry order.
 */
export async function probeRegistry(registry) {
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
