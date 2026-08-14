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
 * The determinism and duplicate rules live in `registry.mjs`, shared with the
 * judge registry ADR 0021 §1 adds. What stays here is the part that is specific
 * to a *provider*: it must expose a `generate` function and a generation
 * manifest. That split is the whole reason there are two registries — see
 * `core/judge/registry.mjs` for why a judge cannot be validated by
 * `validateManifest()`.
 */

import { AdapterError } from '../contracts/errors.mjs';
import { validateManifest } from '../contracts/provider.mjs';
import {
  TRUST_BUILTIN,
  TRUST_EXTERNAL,
  buildRegistry,
  byId,
  invalidRegistration as invalid,
  isPlainObject,
  isTrustClass,
  probeEntries,
} from './registry.mjs';

export { TRUST_BUILTIN, TRUST_EXTERNAL } from './registry.mjs';

/**
 * Normalize one registration into a frozen entry.
 *
 * The manifest is validated as data here rather than trusted from the module,
 * so a built-in with a malformed capability record fails at registration — the
 * cheapest possible moment — instead of at the first paid call.
 */
export function normalizeEntry(raw, { trust = TRUST_BUILTIN } = {}) {
  if (!isPlainObject(raw)) throw invalid('A provider registration must be an object');
  if (!isTrustClass(trust)) {
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
 * Build a registry from raw registrations, all of one trust class.
 *
 * @param {Array<object>} entries
 * @param {{trust?: string}} [options]
 */
export function createRegistry(entries = [], { trust = TRUST_BUILTIN } = {}) {
  if (!Array.isArray(entries)) throw invalid('createRegistry requires an array of providers');
  return buildRegistry(entries.map((entry) => normalizeEntry(entry, { trust })), { noun: 'provider' });
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
    .sort(byId);

  return buildRegistry([...bundled, ...configured], { noun: 'provider' });
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

/**
 * Probe every registered provider. Used by reporting surfaces (`doctor`) that
 * must distinguish available from unavailable without spending a paid call.
 *
 * Results come back in registry order; a detect that throws is one unavailable
 * row rather than a dead report (`probeEntries`).
 */
export async function probeRegistry(registry) {
  return probeEntries(registry);
}
